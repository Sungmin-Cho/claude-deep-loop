import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readState, writeState, withLock } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { slugify } from './slug.mjs';

const NON_TERMINAL = ['planned', 'in_progress', 'in_review', 'parked'];
const TERMINAL = ['ready', 'merged', 'abandoned'];

export function newWorkstream(root, runId, { title, branch, worktree, baseCommit = null, dependsOn = [] }) {
  let id;
  appendAnchored(root, runId, { type: 'workstream-new', data: { title } }, (loop) => {
    const n = String(loop.workstreams.length + 1).padStart(2, '0');
    id = `ws-${n}-${slugify(title) || 'ws'}`;
    loop.workstreams.push({
      id, title, status: 'planned', branch, worktree, base_commit: baseCommit,
      dirty_on_handoff: false, pr: { intended: true, state: 'none', url: null },
      episodes: [], review_points_done: [], depends_on: dependsOn,
    });
  });
  return { id };
}

export function setWorkstreamStatus(root, runId, wsId, status) {
  if (TERMINAL.includes(status)) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${status} is kernel-derived (use recordWorkstreamTerminal)`);
  if (!NON_TERMINAL.includes(status)) throw new Error(`WORKSTREAM_STATUS_INVALID: ${status}`);
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
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

export function recordWorkstreamTerminal(root, runId, wsId, { status, proof = {} }) {
  if (!TERMINAL.includes(status)) throw new Error(`WORKSTREAM_STATUS_INVALID: ${status} is not terminal`);
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} requires proof object`);
  // Codex r2 🔴5: 터미널은 proof **내용**에서 파생/검증 — 임의 status+빈/무관 proof 로 ready/merged/abandoned 못 함 (spec §4).
  // 검증은 appendAnchored 이전(이벤트 append 전)에 — mutate 안에서 throw 하면 event_log_head 앵커가 stale 된다.
  const { data } = readState(root, runId);
  const ws = data.workstreams.find(w => w.id === wsId);
  if (!ws) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
  // Codex r2 🔴: 터미널→터미널 전환 차단 — merged/abandoned 는 흡수 상태; 유일한 허용 전환은 ready→merged.
  if (TERMINAL.includes(ws.status)) {
    if (!(ws.status === 'ready' && status === 'merged')) {
      throw new Error('WORKSTREAM_TERMINAL_LOCKED: ' + wsId + ' ' + ws.status + '->' + status + ' not allowed');
    }
  }
  const reviewPoints = (data.review?.points || []);
  const ok =
    status === 'ready'     ? (reviewPoints.length > 0 && reviewPoints.every(p => (ws.review_points_done || []).includes(p))) :
    status === 'merged'    ? (typeof proof.merge_commit === 'string' && proof.human_approved === true) :   // 비가역 = 사람 승인 (proposal-only, §15)
    status === 'abandoned' ? (typeof proof.reason === 'string' && proof.reason.length > 0) : false;
  if (!ok) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} -> ${status} proof insufficient`);
  appendAnchored(root, runId, { type: 'workstream-terminal', data: { id: wsId, status, proof } }, (loop) => {
    const w = loop.workstreams.find(x => x.id === wsId);
    if (!w) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
    w.status = status;
    loop.active_workstreams = loop.active_workstreams.filter(x => x !== wsId);
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
  for (const w of ws) for (const d of (w.depends_on || [])) if (!ids.has(d)) missing.push({ id: w.id, missing_dep: d });
  if (missing.length) return { order: [], cycle: false, missing };
  const deps = new Map(ws.map(w => [w.id, (w.depends_on || [])]));
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
