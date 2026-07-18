import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, dirname, basename } from 'node:path';
import { appendAnchored, directMutationOptions, intentField, readVerifiedState,
  withVerifiedMutationLock, workstreamNewIntent } from './integrity.mjs';
import { slugify } from './slug.mjs';
import { leaseCheck } from './lease.mjs';
import { MUTATION_TURN_FLOOR } from './budget.mjs';
import { normalizePortableRelativePath, pathWithin } from './fs-safe.mjs';

const NON_TERMINAL = ['planned', 'in_progress', 'in_review', 'parked'];
const TERMINAL = ['ready', 'merged', 'abandoned'];

export function newWorkstream(root, runId, {
  title, branch, worktree, baseCommit = null, dependsOn = [], requestId, fence,
} = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) {
    throw new Error('FENCE_REQUIRED: newWorkstream');
  }
  if (typeof title !== 'string' || title.length === 0
      || typeof branch !== 'string' || branch.length === 0
      || typeof worktree !== 'string' || worktree.length === 0) {
    throw new Error('WORKSTREAM_INPUT_INVALID: title/branch/worktree must be non-empty strings');
  }
  if (!Array.isArray(dependsOn)
      || dependsOn.some(dependency => typeof dependency !== 'string' || dependency.length === 0)) {
    throw new Error('WORKSTREAM_INPUT_INVALID: dependsOn must be an array of strings');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId || '')) {
    throw new Error('WORKSTREAM_REQUEST_ID_REQUIRED');
  }
  const rootResolved = realpathSync(root);
  function resolveDeep(path) {
    const absolute = resolve(path);
    if (existsSync(absolute)) return realpathSync(absolute);
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`WORKSTREAM_WORKTREE_ESCAPE: dangling symlink component: ${absolute}`);
      }
    } catch (error) {
      if (String(error?.message || error).startsWith('WORKSTREAM_WORKTREE_ESCAPE')) throw error;
      if (error?.code !== 'ENOENT') {
        throw new Error(`WORKSTREAM_WORKTREE_ESCAPE: unresolved worktree component: ${absolute}`,
          { cause: error });
      }
    }
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(resolveDeep(parent), basename(absolute));
  }
  const absoluteInput = isAbsolute(worktree);
  const portableInput = absoluteInput ? null : normalizePortableRelativePath(worktree);
  if (!absoluteInput && !portableInput) {
    throw new Error(`WORKSTREAM_WORKTREE_ESCAPE: invalid relative worktree path: ${worktree}`);
  }
  const resolved = resolveDeep(absoluteInput ? worktree : join(rootResolved, portableInput));
  const conventionRoots = [join(rootResolved, '.claude', 'worktrees'),
    join(rootResolved, '.worktrees')];
  const underConvention = conventionRoots.some(base =>
    pathWithin(base, resolved) && relative(base, resolved) !== '');
  if (worktree.split(/[/\\]/).includes('..') || !underConvention) {
    throw new Error(`WORKSTREAM_WORKTREE_ESCAPE: worktree must resolve under project root: ${worktree}`);
  }
  const storedWorktree = normalizePortableRelativePath(relative(rootResolved, resolved));
  if (!storedWorktree) {
    throw new Error(`WORKSTREAM_WORKTREE_ESCAPE: worktree is not durably relative: ${worktree}`);
  }
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const requestProjection = { title, branch, worktree: storedWorktree,
    baseCommit, dependsOn: structuredClone(dependsOn) };
  const requestIdDigest = intentField('workstream-create-request-id', requestId);
  const requestDigest = intentField('workstream-create-request', requestProjection);
  const intentDigest = workstreamNewIntent(callerBinding,
    { ...requestProjection, requestIdDigest, requestDigest });
  const fenceCheck = loop => {
    const result = leaseCheck(loop, fence);
    if (!result.ok) throw new Error(`LEASE_FENCED: ${result.reason}`);
  };
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'LEASE_FENCED: newWorkstream' }, mutation => {
    const loop = mutation.readVerifiedState({ fenceCheck }).data;
    const matches = loop.workstreams.filter(workstreamRecord =>
      workstreamRecord.creation_request_id_digest === requestIdDigest);
    if (matches.length > 1) throw new Error('WORKSTREAM_RESPONSE_PROJECTION_CHANGED');
    if (matches.length === 1) {
      const [existing] = matches;
      if (existing.creation_contract !== 'workstream-create-v1'
          || existing.creation_request_digest !== requestDigest
          || existing.title !== title || existing.branch !== branch
          || existing.worktree !== storedWorktree || existing.base_commit !== baseCommit
          || JSON.stringify(existing.depends_on) !== JSON.stringify(dependsOn)) {
        throw new Error('WORKSTREAM_REQUEST_CONFLICT');
      }
      return { id: existing.id };
    }
    if (mutation.recovered !== null) {
      throw new Error('WORKSTREAM_RESPONSE_PROJECTION_CHANGED');
    }
    const number = String(loop.workstreams.length + 1).padStart(2, '0');
    const id = `ws-${number}-${slugify(title) || 'ws'}`;
    const event = { type: 'workstream-new', data: { id, title,
      creation_contract: 'workstream-create-v1',
      creation_request_id_digest: requestIdDigest,
      creation_request_digest: requestDigest,
      request_projection: requestProjection } };
    mutation.appendAnchored(event, candidate => {
      candidate.workstreams.push({
        id, title, status: 'planned', branch, worktree: storedWorktree,
        base_commit: baseCommit, dirty_on_handoff: false,
        pr: { intended: true, state: 'none', url: null }, episodes: [],
        review_points_done: [], depends_on: structuredClone(dependsOn),
        creation_contract: 'workstream-create-v1',
        creation_request_id_digest: requestIdDigest,
        creation_request_digest: requestDigest,
      });
    }, undefined, { floor: MUTATION_TURN_FLOOR });
    return { id };
  });
}

export function setWorkstreamStatus(root, runId, wsId, status,
  { fence } = {}) {
  if (TERMINAL.includes(status)) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${status} is kernel-derived (use recordWorkstreamTerminal)`);
  if (!NON_TERMINAL.includes(status)) throw new Error(`WORKSTREAM_STATUS_INVALID: ${status}`);
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: setWorkstreamStatus');
  appendAnchored(root, runId, { type: 'workstream-status', data: { id: wsId, status } },
    loop => {
      if (status === 'in_progress' && !loop.active_workstreams.includes(wsId)) {
        loop.active_workstreams.push(wsId);
      }
      if (status === 'parked') {
        loop.active_workstreams = loop.active_workstreams.filter(id => id !== wsId);
      }
      loop.workstreams.find(workstream => workstream.id === wsId).status = status;
    },
    loop => {
      const authorized = leaseCheck(loop, fence);
      if (!authorized.ok) throw new Error('LEASE_FENCED: ' + authorized.reason);
      const workstream = loop.workstreams.find(item => item.id === wsId);
      if (!workstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
      if (TERMINAL.includes(workstream.status)) {
        throw new Error(`WORKSTREAM_TERMINAL_LOCKED: ${wsId} is ${workstream.status}`);
      }
      if (status === 'in_progress' && !loop.active_workstreams.includes(wsId)) {
        const cap = loop.autonomy?.max_parallel ?? 2;
        if (loop.active_workstreams.length >= cap) {
          throw new Error(`MAX_PARALLEL_EXCEEDED: ${loop.active_workstreams.length}/${cap}`);
        }
      }
    },
    directMutationOptions('workstream-status', fence, { wsId, status },
      'LEASE_FENCED: setWorkstreamStatus', {
        floor: MUTATION_TURN_FLOOR, onRecovered: loop => {
          if (loop.workstreams.find(item => item.id === wsId)?.status !== status) {
            throw new Error('WORKSTREAM_RESPONSE_PROJECTION_CHANGED');
          }
        },
      }));
}

export function recordWorkstreamTerminal(root, runId, wsId, {
  status, proof = {}, fence } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) {
    throw new Error('FENCE_REQUIRED: recordWorkstreamTerminal');
  }
  if (!TERMINAL.includes(status)) {
    throw new Error(`WORKSTREAM_STATUS_INVALID: ${status} is not terminal`);
  }
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} requires proof object`);
  }
  const proofDigest = intentField('workstream-terminal-proof', proof);
  appendAnchored(root, runId,
    { type: 'workstream-terminal', data: { id: wsId, status, proof } }, loop => {
      const workstream = loop.workstreams.find(item => item.id === wsId);
      if (!workstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
      workstream.status = status;
      loop.active_workstreams = loop.active_workstreams.filter(id => id !== wsId);
    }, loop => {
      const authorized = leaseCheck(loop, fence);
      if (!authorized.ok) throw new Error('LEASE_FENCED: ' + authorized.reason);
      const workstream = loop.workstreams.find(item => item.id === wsId);
      if (!workstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
      if (TERMINAL.includes(workstream.status)
          && !(workstream.status === 'ready' && status === 'merged')) {
        throw new Error('WORKSTREAM_TERMINAL_LOCKED: ' + wsId + ' '
          + workstream.status + '->' + status + ' not allowed');
      }
      const reviewPoints = loop.review?.points || [];
      const sufficient = status === 'ready'
        ? reviewPoints.length > 0
          && reviewPoints.every(point =>
            (workstream.review_points_done || []).includes(point))
        : status === 'merged'
          ? typeof proof.merge_commit === 'string' && proof.human_approved === true
          : status === 'abandoned'
            ? typeof proof.reason === 'string' && proof.reason.length > 0 : false;
      if (!sufficient) {
        throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} -> ${status} proof insufficient`);
      }
    }, directMutationOptions('workstream-terminal', fence,
      { wsId, status, proofDigest }, 'LEASE_FENCED: recordWorkstreamTerminal', {
        floor: MUTATION_TURN_FLOOR, onRecovered: loop => {
          if (loop.workstreams.find(item => item.id === wsId)?.status !== status) {
            throw new Error('WORKSTREAM_RESPONSE_PROJECTION_CHANGED');
          }
        },
      }));
}

export function inheritWorkstreams(root, runId, { existsFn = existsSync } = {}) {
  if (typeof existsFn !== 'function') throw new Error('WORKSPACE_EXISTS_FN_INVALID');
  const data = readVerifiedState(root, runId).data;
  const inherited = [];
  const missing = [];
  for (const id of data.active_workstreams) {
    const workstream = data.workstreams.find(item => item.id === id);
    if (!workstream) {
      missing.push({ id, reason: 'workstream-record-missing' });
      continue;
    }
    const path = isAbsolute(workstream.worktree)
      ? workstream.worktree : join(root, workstream.worktree);
    if (existsFn(path)) inherited.push(id);
    else missing.push({ id, worktree: workstream.worktree,
      reason: 'worktree-path-missing' });
  }
  return { inherited, missing };
}
export function integrationOrder(loop) {
  const ws = loop.workstreams || [];
  const ids = new Set(ws.map(w => w.id));
  // Codex r2 🟡9: 미지 의존을 silent drop 하지 않는다 — 오타/누락 id 는 needs-human 에스컬레이션.
  const missing = [];
  for (const w of ws) for (const d of (Array.isArray(w.depends_on) ? w.depends_on : [])) if (!ids.has(d)) missing.push({ id: w.id, missing_dep: d });
  if (missing.length) return { order: [], cycle: false, missing };
  const deps = new Map(ws.map(w => [w.id, (Array.isArray(w.depends_on) ? w.depends_on : [])]));
  const order = [], state = new Map(); // 0=unseen 1=visiting 2=done
  let cycle = false;
  const visit = (id) => {
    if (cycle) return;
    const s = state.get(id) || 0;
    if (s === 2) return;
    if (s === 1) { cycle = true; return; }
    state.set(id, 1);
    for (const d of deps.get(id) || []) visit(d);
    state.set(id, 2);
    order.push(id);
  };
  for (const w of ws) visit(w.id);
  return { order: cycle ? [] : order, cycle, missing: [] };
}
