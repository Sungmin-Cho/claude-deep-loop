import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path, { join } from 'node:path';
import { captureVerifiedRunSet, captureVerifiedRunSnapshot } from './integrity.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import {
  normalizePortableRelativePath,
  pathWithin,
  recordedClaimKey,
} from './fs-safe.mjs';

const ACTIVE = new Set(['running', 'paused']);
const TERMINAL_WORKSTREAM = new Set(['ready', 'merged', 'abandoned']);
const TERMINAL_RUN = new Set(['completed', 'stopped', 'abandoned', 'terminal', 'finished']);
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNSAFE_RUN_ID = /[\x00-\x1F\x7F-\x9F/\\]/;
const PURPOSES = new Set(['hook-checkpoint', 'hook-restore', 'headless', 'cli-read']);

function safeRunId(value) {
  return typeof value === 'string' && value !== '.' && value !== '..'
    && !UNSAFE_RUN_ID.test(value) && SAFE_RUN_ID.test(value);
}

function compareCodeUnits(left, right) {
  const a = String(left);
  const b = String(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function boundedCandidates(values) {
  const sorted = [...values].sort((left, right) => compareCodeUnits(left.run_id, right.run_id));
  return Object.freeze(sorted.slice(0, 5).map(value => Object.freeze({
    run_id: value.run_id,
    status: value.status,
  })));
}

function invalid(reason, extra = {}) {
  return Object.freeze({ ok: false, kind: 'invalid', reason, ...extra });
}

function none(reason) {
  return Object.freeze({ ok: true, kind: 'none', reason });
}

function selected(source, run, snapshot, matchedWorktree) {
  return Object.freeze({
    ok: true,
    kind: 'selected',
    runId: run.run_id,
    source,
    status: run.status,
    snapshot,
    ...(matchedWorktree ? { matchedWorktree } : {}),
  });
}

function identityValue(identity, lower, upper) {
  if (!identity || typeof identity !== 'object') return undefined;
  const snake = lower.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  return identity[lower] ?? identity[upper] ?? identity[snake];
}

function truthyMarker(value) {
  return value === true || value === 1 || value === '1';
}

function completeEnvIdentity(identity, purpose, root, realpathFn) {
  if (purpose !== 'headless' || !identity || typeof identity !== 'object') return null;
  const values = {
    runId: identityValue(identity, 'runId', 'DEEP_LOOP_RUN_ID'),
    projectRoot: identityValue(identity, 'projectRoot', 'DEEP_LOOP_PROJECT_ROOT'),
    owner: identityValue(identity, 'owner', 'DEEP_LOOP_OWNER'),
    generation: identityValue(identity, 'generation', 'DEEP_LOOP_GENERATION'),
    headless: identityValue(identity, 'headless', 'DEEP_LOOP_HEADLESS'),
    unattended: identityValue(identity, 'unattended', 'DEEP_LOOP_UNATTENDED'),
  };
  const present = Object.values(values).every(value => value !== undefined && value !== null && value !== '');
  if (!present) return null;
  if (!safeRunId(String(values.runId))
    || typeof values.owner !== 'string' || values.owner.length === 0
    || !/^[1-9]\d*$/.test(String(values.generation))
    || !Number.isSafeInteger(Number(values.generation))
    || !truthyMarker(values.headless) || !truthyMarker(values.unattended)) {
    return { invalid: true };
  }
  let canonicalEnv;
  let canonicalRoot;
  try {
    canonicalEnv = canonicalProjectRoot(String(values.projectRoot), { realpathSync: realpathFn });
    canonicalRoot = canonicalProjectRoot(root, { realpathSync: realpathFn });
  } catch {
    return { invalid: true };
  }
  if (canonicalEnv !== canonicalRoot) return { invalid: true };
  return {
    runId: String(values.runId),
    owner: String(values.owner),
    generation: Number(values.generation),
  };
}

function canonicalRootOf(root, realpathFn) {
  return canonicalProjectRoot(root, { realpathSync: realpathFn });
}

function unwrapCapture(value) {
  if (value?.ok === false) return null;
  return value?.snapshot || value;
}

function snapshotRun(snapshot, runId, root, realpathFn) {
  if (!snapshot?.data || snapshot.data.run_id !== runId) return false;
  try {
    return canonicalRootOf(snapshot.data.project?.root, realpathFn)
      === canonicalRootOf(root, realpathFn);
  } catch {
    return false;
  }
}

function normalizeRunSet(captured, root, realpathFn) {
  if (!captured || typeof captured !== 'object') return invalid('run-set-integrity');
  if (captured.kind === 'run-set-bound-exceeded' || captured.reason === 'run-set-bound-exceeded') {
    return invalid('run-set-bound-exceeded', {
      max_run_ids: captured.max_run_ids,
      deadline_ms: captured.deadline_ms,
      observed_count: captured.observed_count,
      total_is_lower_bound: captured.total_is_lower_bound,
    });
  }
  const errors = captured.errors && typeof captured.errors === 'object' ? captured.errors : {};
  const errorIds = Object.keys(errors).sort(compareCodeUnits);
  if (captured.ok === false || errorIds.length > 0) {
    const hasReconciliation = errorIds.some(id => errors[id]?.kind === 'reconciliation-required');
    const projected = Object.fromEntries(errorIds.slice(0, 5).map(id => [id, {
      kind: errors[id]?.kind || 'integrity-invalid',
      ...(errors[id]?.operation_id ? { operation_id: errors[id].operation_id } : {}),
      ...(errors[id]?.phase ? { phase: errors[id].phase } : {}),
    }]));
    return invalid(hasReconciliation ? 'reconciliation-required' : 'run-set-integrity', {
      errors: Object.freeze(projected),
      total: errorIds.length,
    });
  }
  const runs = captured.runs && typeof captured.runs === 'object' ? captured.runs : null;
  if (!runs) return invalid('run-set-integrity');
  const entries = [];
  for (const runId of Object.keys(runs).sort(compareCodeUnits)) {
    if (!safeRunId(runId)) {
      return invalid('run-set-integrity', {
        errors: Object.freeze({ [runId]: { kind: 'integrity-invalid' } }),
        total: 1,
      });
    }
    const snapshot = unwrapCapture(runs[runId]);
    if (!snapshotRun(snapshot, runId, root, realpathFn)) {
      return invalid('run-set-integrity', {
        errors: Object.freeze({ [runId]: { kind: 'integrity-invalid' } }),
        total: 1,
      });
    }
    entries.push({ run_id: runId, status: snapshot.data.status, snapshot });
  }
  return entries;
}

function captureFailure(runId, failure) {
  const message = typeof failure?.message === 'string' ? failure.message : String(failure ?? '');
  const rawKind = failure?.kind || failure?.code || (message.includes('reconciliation')
    ? 'reconciliation-required' : 'integrity-invalid');
  const reconciliation = rawKind === 'reconciliation-required'
    || String(rawKind).includes('TRANSACTION_RECONCILIATION');
  const detail = {
    kind: reconciliation ? 'reconciliation-required' : 'integrity-invalid',
    ...(typeof failure?.operation_id === 'string' ? { operation_id: failure.operation_id } : {}),
    ...(typeof failure?.phase === 'string' ? { phase: failure.phase } : {}),
  };
  return invalid(reconciliation ? 'reconciliation-required' : 'identity-invalid', {
    errors: Object.freeze({ [runId]: Object.freeze(detail) }),
    total: 1,
  });
}

function currentRunId(root) {
  const path = join(root, '.deep-loop', 'current');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    return safeRunId(value) ? value : null;
  } catch {
    return null;
  }
}

function claimInventory(root, entries, platform, realpathFn, pathApi) {
  const claims = [];
  const errors = [];
  for (const run of entries) {
    const workstreams = Array.isArray(run.snapshot.data.workstreams)
      ? run.snapshot.data.workstreams : [];
    for (const workstream of workstreams) {
      if (typeof workstream?.worktree !== 'string') continue;
      const key = recordedClaimKey({
        root,
        worktree: workstream.worktree,
        platform,
        realpathFn,
        pathApi,
      });
      const normalizedWorktree = key.ok ? key.normalized : '';
      const convention = platform === 'win32'
        ? (normalizedWorktree.toLowerCase().startsWith('.claude/worktrees/')
          || normalizedWorktree.toLowerCase().startsWith('.worktrees/'))
        : (normalizedWorktree.startsWith('.claude/worktrees/') || normalizedWorktree.startsWith('.worktrees/'));
      let contained = false;
      if (key.ok && convention) {
        const candidate = key.canonical || key.absolute;
        const roots = [pathApi?.resolve(root, '.claude', 'worktrees'), pathApi?.resolve(root, '.worktrees')];
        contained = pathWithin(root, candidate, { pathApi })
          && roots.some(base => pathWithin(base, candidate, { pathApi })
            && pathApi.relative(base, candidate) !== '');
      }
      if (!key.ok || !contained) {
        errors.push({ run_id: run.run_id, kind: 'integrity-invalid' });
        continue;
      }
      claims.push({
        run,
        workstream,
        key,
        terminal: TERMINAL_WORKSTREAM.has(workstream.status) || TERMINAL_RUN.has(run.status),
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, claims };
}

function duplicateClaims(claims) {
  const byKey = new Map();
  for (const claim of claims) {
    for (const key of claim.key.keys) {
      const list = byKey.get(key) || [];
      list.push(claim);
      byKey.set(key, list);
    }
  }
  const duplicate = new Map();
  for (const list of byKey.values()) {
    if (list.length > 1) for (const claim of list) duplicate.set(claim.run.run_id, claim.run);
  }
  return [...duplicate.values()];
}

function containedClaim(claim, cwd, root, pathApi) {
  const candidate = claim.key.canonical || claim.key.absolute;
  if (!candidate) return false;
  try {
    return pathWithin(root, candidate, { pathApi })
      && pathWithin(candidate, cwd, { pathApi });
  } catch {
    return false;
  }
}

function claimSpecificity(claim) {
  return claim.key.normalized.split('/').length;
}

function selectLegacyCurrent(root, entries, claims, cwd, realpathFn, pathApi, currentRunIdFn = currentRunId) {
  const rawCurrent = currentRunIdFn(root);
  if (rawCurrent !== null && rawCurrent !== undefined && !safeRunId(rawCurrent)) return none('stale-current');
  const current = safeRunId(rawCurrent) ? rawCurrent : null;
  if (!current) return none(existsSync(join(root, '.deep-loop', 'current')) ? 'stale-current' : 'no-current');
  const run = entries.find(entry => entry.run_id === current);
  if (!run) return none('stale-current');
  if (ACTIVE.has(run.status)) return none('no-active-run');
  const terminalClaims = claims.filter(claim => claim.run.run_id === current && claim.terminal);
  if (terminalClaims.length < 1) return none('terminal-residue');
  if (cwd) {
    const matches = terminalClaims.filter(claim => containedClaim(claim, cwd, root, pathApi));
    if (matches.length > 0) {
      const deepest = matches.slice().sort((left, right) => (
        claimSpecificity(right) - claimSpecificity(left)
        || compareCodeUnits(left.key.normalized, right.key.normalized)
      ))[0];
      return selected('legacy-current', run, run.snapshot, deepest.workstream.worktree);
    }
  }
  if (!cwd) return selected('legacy-current', run, run.snapshot);
  return selected('legacy-current', run, run.snapshot);
}

export function resolveRunContext({
  root,
  explicitRunId = null,
  envIdentity = null,
  cwd = null,
  purpose,
  lockOptions,
  nowFn,
  sleepFn,
  opendirFn,
  captureRunSnapshot = captureVerifiedRunSnapshot,
  captureRunSet = captureVerifiedRunSet,
  realpathFn = realpathSync.native || realpathSync,
  pathApi = path,
  platform = process.platform,
  currentRunIdFn = currentRunId,
} = {}) {
  if (typeof purpose !== 'undefined' && !PURPOSES.has(purpose)) return invalid('invalid-purpose');
  let canonicalRoot;
  try { canonicalRoot = canonicalRootOf(root, realpathFn); }
  catch { return invalid('root-unresolvable'); }

  const hasExplicit = explicitRunId !== null && explicitRunId !== undefined && explicitRunId !== '';
  if (hasExplicit && !safeRunId(String(explicitRunId))) return invalid('invalid-run-id');
  const env = completeEnvIdentity(envIdentity, purpose, canonicalRoot, realpathFn);
  if (env?.invalid) return invalid('identity-conflict');
  if (hasExplicit && env && env.runId !== String(explicitRunId)) return invalid('identity-conflict');
  const identityRunId = hasExplicit ? String(explicitRunId) : env?.runId;
  if (identityRunId) {
    let captured;
    try {
      captured = captureRunSnapshot(canonicalRoot, identityRunId, { lockOptions, nowFn, sleepFn });
    } catch (error) {
      return captureFailure(identityRunId, error);
    }
    if (captured?.ok === false) return captureFailure(identityRunId, captured);
    const snapshot = unwrapCapture(captured);
    if (!snapshotRun(snapshot, identityRunId, canonicalRoot, realpathFn)) {
      return invalid('identity-invalid', { errors: Object.freeze({ [identityRunId]: { kind: 'integrity-invalid' } }), total: 1 });
    }
    const run = { run_id: identityRunId, status: snapshot.data.status };
    return selected(hasExplicit ? 'explicit' : 'env', run, snapshot);
  }

  let capturedSet;
  try {
    capturedSet = captureRunSet(canonicalRoot, {
      maxRunIds: 64,
      deadlineMs: 500,
      lockOptions,
      nowFn,
      sleepFn,
      opendirFn,
    });
  } catch (error) {
    if (error?.kind === 'run-set-bound-exceeded' || String(error?.message || '').includes('run-set-bound-exceeded')) {
      return invalid('run-set-bound-exceeded', {
        max_run_ids: error.max_run_ids,
        deadline_ms: error.deadline_ms,
        observed_count: error.observed_count,
        total_is_lower_bound: error.total_is_lower_bound,
      });
    }
    return invalid('run-set-integrity');
  }
  const entries = normalizeRunSet(capturedSet, canonicalRoot, realpathFn);
  if (!Array.isArray(entries)) return entries;
  if (entries.length === 0) return none('no-runs');
  const inventory = claimInventory(canonicalRoot, entries, platform, realpathFn, pathApi);
  if (!inventory.ok) return invalid('run-set-integrity', {
    errors: Object.freeze(Object.fromEntries(
      [...new Map(inventory.errors.map(error => [error.run_id, { kind: error.kind }]))]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .slice(0, 5),
    )),
    total: new Set(inventory.errors.map(error => error.run_id)).size,
  });
  const duplicates = duplicateClaims(inventory.claims);
  if (duplicates.length > 0) {
    return Object.freeze({
      ok: false,
      kind: 'ambiguous',
      reason: 'duplicate-worktree-claim',
      candidates: boundedCandidates(duplicates),
      total: duplicates.length,
    });
  }

  let canonicalCwd = null;
  if (cwd !== null && cwd !== undefined) {
    try { canonicalCwd = realpathFn(cwd); }
    catch { return invalid('cwd-unresolvable'); }
  }
  const active = entries.filter(run => ACTIVE.has(run.status));
  if (canonicalCwd) {
    const terminalMatches = inventory.claims.filter(claim => claim.terminal
      && containedClaim(claim, canonicalCwd, canonicalRoot, pathApi));
    if (terminalMatches.length > 0) {
      if (active.length > 0) return none('terminal-residue');
      const terminalRuns = new Set(terminalMatches.map(claim => claim.run.run_id));
      if (terminalRuns.size > 1) return none('terminal-residue');
      const current = currentRunIdFn(canonicalRoot);
      if (current !== [...terminalRuns][0]) return none('terminal-residue');
      return selectLegacyCurrent(canonicalRoot, entries, inventory.claims, canonicalCwd, realpathFn, pathApi, currentRunIdFn);
    }
    const matches = inventory.claims.filter(claim => !claim.terminal
      && ACTIVE.has(claim.run.status)
      && containedClaim(claim, canonicalCwd, canonicalRoot, pathApi));
    const matchedRuns = new Map(matches.map(claim => [claim.run.run_id, claim]));
    if (matchedRuns.size === 1) {
      const claim = [...matchedRuns.values()][0];
      return selected('worktree', claim.run, claim.run.snapshot, claim.workstream.worktree);
    }
    if (matchedRuns.size > 1) {
      return Object.freeze({
        ok: false,
        kind: 'ambiguous',
        reason: 'multi-active-root-cwd',
        candidates: boundedCandidates([...matchedRuns.values()].map(claim => claim.run)),
        total: matchedRuns.size,
      });
    }
  }
  if (active.length === 1) return selected('single-active', active[0], active[0].snapshot);
  if (active.length > 1) {
    return Object.freeze({
      ok: false,
      kind: 'ambiguous',
      reason: 'multi-active-root-cwd',
      candidates: boundedCandidates(active),
      total: active.length,
    });
  }
  return selectLegacyCurrent(canonicalRoot, entries, inventory.claims, canonicalCwd, realpathFn, pathApi, currentRunIdFn);
}
