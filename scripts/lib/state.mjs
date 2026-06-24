import { readFileSync, writeFileSync, mkdirSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash, atomicWrite } from './envelope.mjs';
import { validate } from './schema.mjs';

export function runDir(root, runId) { return join(root, '.deep-loop', 'runs', runId); }
const loopPath = (root, runId) => join(runDir(root, runId), 'loop.json');
const hashPath = (root, runId) => join(runDir(root, runId), '.loop.hash');

// patch 분류기 (spec §4 정확 일치). 정확 경로/패턴만 allow, 나머지 전부 forbid (default-deny).
const TERMINAL_EPISODE = ['done', 'approved', 'rejected'];
const TERMINAL_WORKSTREAM = ['ready', 'merged', 'abandoned'];

// 스킬 patch 허용 경로 (문서/검증용)
export const WHITELIST = new Set([
  'discovered_items', 'decisions', 'active_workstreams',
  'triage.actionable', 'triage.needs_human', 'triage.blocked', 'triage.archived',
  'episodes.<i>.status(non-terminal)', 'episodes.<i>.result_*',
  'workstreams.<i>.status(non-terminal)', 'workstreams.<i>.depends_on',
]);

export function classifyPatch(field, value) {
  if (field === 'discovered_items' || field === 'decisions' || field === 'active_workstreams') return 'allow';
  if (/^triage\.(actionable|needs_human|blocked|archived)$/.test(field)) return 'allow';
  let m = field.match(/^episodes\.\d+\.(.+)$/);
  if (m) {
    const sub = m[1];
    if (sub === 'status') return TERMINAL_EPISODE.includes(value) ? 'forbid' : 'allow';
    if (/^result_[A-Za-z0-9_]+$/.test(sub)) return 'allow';   // 최상위 result_* 만 (result.status / resultEvil 차단)
    return 'forbid';   // verification/worktree/plugin 등 비허용
  }
  m = field.match(/^workstreams\.\d+\.(.+)$/);
  if (m) {
    const sub = m[1];
    if (sub === 'status') return TERMINAL_WORKSTREAM.includes(value) ? 'forbid' : 'allow';
    if (sub === 'depends_on') return 'allow';
    return 'forbid';   // title/pr/worktree/branch/base_commit 등 비허용
  }
  // 배열 요소 전체-객체 patch (episodes.0 / workstreams.0) 및 그 외 모든 경로 차단 → 터미널 우회 방지
  return 'forbid';
}

export function readState(root, runId) {
  const raw = readFileSync(loopPath(root, runId), 'utf8');
  const stored = existsSync(hashPath(root, runId)) ? readFileSync(hashPath(root, runId), 'utf8').trim() : null;
  if (stored !== null && contentHash(raw) !== stored) {
    throw new Error(`STATE_TAMPERED: ${runId} loop.json content-hash mismatch`);
  }
  return { data: JSON.parse(raw), hash: stored };
}

export function writeState(root, runId, data) {
  const v = validate(data);
  if (!v.ok) throw new Error(`SCHEMA_INVALID: ${v.errors.join('; ')}`);
  data.updated_at = new Date().toISOString();
  const raw = JSON.stringify(data, null, 2);
  atomicWrite(loopPath(root, runId), raw);
  atomicWrite(hashPath(root, runId), contentHash(raw));
}

function setPath(obj, path, value) {
  const keys = path.split('.'); const last = keys.pop();
  const t = keys.reduce((o, k) => (o[k] ??= {}), obj);
  t[last] = value;
}

export function patch(root, runId, field, value) {
  if (classifyPatch(field, value) !== 'allow') throw new Error(`FIELD_FORBIDDEN: ${field}`);
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    setPath(data, field, value);
    writeState(root, runId, data);
  });
}

export function withLock(root, runId, fn) {
  const lock = join(runDir(root, runId), '.lock');
  let acquired = false;
  for (let i = 0; i < 50 && !acquired; i++) {
    try { mkdirSync(lock); acquired = true; } catch { /* spin */ }
  }
  if (!acquired) throw new Error(`LOCK_BUSY: ${runId}`);
  try { return fn(); } finally { try { rmdirSync(lock); } catch {} }
}
