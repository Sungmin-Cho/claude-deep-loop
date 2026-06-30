import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep, dirname, basename } from 'node:path';
import { readState, writeState, withLock } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { slugify } from './slug.mjs';
import { leaseCheck } from './lease.mjs';

const NON_TERMINAL = ['planned', 'in_progress', 'in_review', 'parked'];
const TERMINAL = ['ready', 'merged', 'abandoned'];

export function newWorkstream(root, runId, { title, branch, worktree, baseCommit = null, dependsOn = [], fence } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: newWorkstream');
  if (typeof title !== 'string' || title.length === 0 ||
      typeof branch !== 'string' || branch.length === 0 ||
      typeof worktree !== 'string' || worktree.length === 0) {
    throw new Error('WORKSTREAM_INPUT_INVALID: title/branch/worktree must be non-empty strings');
  }
  if (!Array.isArray(dependsOn) || dependsOn.some(d => typeof d !== 'string' || d.length === 0)) {
    throw new Error('WORKSTREAM_INPUT_INVALID: dependsOn must be an array of strings');
  }
  // §0.6-2: containment — worktree must resolve strictly inside a convention dir:
  //   <root>/.claude/worktrees/  OR  <root>/.worktrees/
  // Root-self ('.', root) and arbitrary under-root paths are rejected; only convention dirs accepted.
  // R5 P2-2: existing paths use realpathSync (blocks symlink escapes); non-existent paths walk up to
  // the nearest existing ancestor for symlink resolution (handles /tmp→/private/tmp on macOS).
  const _rootResolved = realpathSync(root);
  function _resolveDeep(p) {
    const abs = resolve(p);
    if (existsSync(abs)) return realpathSync(abs);
    const par = dirname(abs);
    if (par === abs) return abs; // filesystem root — can't walk further
    return join(_resolveDeep(par), basename(abs));
  }
  const _wtBase = isAbsolute(worktree) ? worktree : join(_rootResolved, worktree);
  const _wtResolved = _resolveDeep(_wtBase);
  // Convention prefixes are lexical (rooted at resolved root) — do NOT resolve the convention dirs
  // themselves, so a symlinked .claude/worktrees pointing outside root is still rejected.
  const _conv1 = _rootResolved + sep + '.claude' + sep + 'worktrees' + sep;
  const _conv2 = _rootResolved + sep + '.worktrees' + sep;
  const _underConvention = _wtResolved.startsWith(_conv1) || _wtResolved.startsWith(_conv2);
  if (worktree.split(/[/\\]/).includes('..') || !_underConvention) {
    throw new Error('WORKSTREAM_WORKTREE_ESCAPE: worktree must resolve under project root: ' + worktree);
  }
  let id;
  appendAnchored(root, runId, { type: 'workstream-new', data: { title } }, (loop) => {
    const n = String(loop.workstreams.length + 1).padStart(2, '0');
    id = `ws-${n}-${slugify(title) || 'ws'}`;
    loop.workstreams.push({
      id, title, status: 'planned', branch, worktree, base_commit: baseCommit,
      dirty_on_handoff: false, pr: { intended: true, state: 'none', url: null },
      episodes: [], review_points_done: [], depends_on: dependsOn,
    });
  }, fence ? (loop) => { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); } : undefined);
  return { id };
}

export function setWorkstreamStatus(root, runId, wsId, status, opts = {}) {
  if (TERMINAL.includes(status)) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${status} is kernel-derived (use recordWorkstreamTerminal)`);
  if (!NON_TERMINAL.includes(status)) throw new Error(`WORKSTREAM_STATUS_INVALID: ${status}`);
  const { fence } = opts;
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: setWorkstreamStatus');
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    if (fence) { const r = leaseCheck(data, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    const ws = data.workstreams.find(w => w.id === wsId);
    if (!ws) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
    if (['ready', 'merged', 'abandoned'].includes(ws.status)) throw new Error(`WORKSTREAM_TERMINAL_LOCKED: ${wsId} is ${ws.status}`);
    if (status === 'in_progress' && !data.active_workstreams.includes(wsId)) {
      const cap = data.autonomy?.max_parallel ?? 2;
      if (data.active_workstreams.length >= cap) throw new Error(`MAX_PARALLEL_EXCEEDED: ${data.active_workstreams.length}/${cap}`);
      data.active_workstreams.push(wsId);
    }
    if (status === 'parked') data.active_workstreams = data.active_workstreams.filter(x => x !== wsId);
    ws.status = status;
    writeState(root, runId, data);
  });
}

export function recordWorkstreamTerminal(root, runId, wsId, { status, proof = {}, fence } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: recordWorkstreamTerminal');
  // Cheap input validation (no atomicity required)
  if (!TERMINAL.includes(status)) throw new Error(`WORKSTREAM_STATUS_INVALID: ${status} is not terminal`);
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} requires proof object`);
  appendAnchored(root, runId, { type: 'workstream-terminal', data: { id: wsId, status, proof } }, (loop) => {
    const w = loop.workstreams.find(x => x.id === wsId);
    if (!w) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
    w.status = status;
    loop.active_workstreams = loop.active_workstreams.filter(x => x !== wsId);
  }, (loop) => {
    // Codex r3 🔴: all throwing validations inside preCheck on fresh loop (atomic terminal guard)
    if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    const ws = loop.workstreams.find(w => w.id === wsId);
    if (!ws) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
    // Codex r2 🔴: 터미널→터미널 전환 차단 — merged/abandoned 는 흡수 상태; 유일한 허용 전환은 ready→merged.
    if (TERMINAL.includes(ws.status)) {
      if (!(ws.status === 'ready' && status === 'merged')) {
        throw new Error('WORKSTREAM_TERMINAL_LOCKED: ' + wsId + ' ' + ws.status + '->' + status + ' not allowed');
      }
    }
    const reviewPoints = (loop.review?.points || []);
    const ok =
      status === 'ready'     ? (reviewPoints.length > 0 && reviewPoints.every(p => (ws.review_points_done || []).includes(p))) :
      status === 'merged'    ? (typeof proof.merge_commit === 'string' && proof.human_approved === true) :
      status === 'abandoned' ? (typeof proof.reason === 'string' && proof.reason.length > 0) : false;
    if (!ok) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} -> ${status} proof insufficient`);
  });
}

// respawn 인수: active worktree 경로가 디스크에 존재하는지만 확인. 누락은 조용히 재생성 ❌ → fail-safe.
export function inheritWorkstreams(root, runId) {
  const { data } = readState(root, runId);
  const inherited = [], missing = [];
  for (const id of data.active_workstreams) {
    const ws = data.workstreams.find(w => w.id === id);
    if (!ws) { missing.push({ id, reason: 'workstream-record-missing' }); continue; }
    const path = isAbsolute(ws.worktree) ? ws.worktree : join(root, ws.worktree);
    if (existsSync(path)) inherited.push(id);
    else missing.push({ id, worktree: ws.worktree, reason: 'worktree-path-missing' });
  }
  return { inherited, missing };
}

// 머지 순서 = depends_on 위상정렬 (spec §8.1). 순환 + 미지 의존 탐지.
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
