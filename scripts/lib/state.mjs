import { readFileSync, writeFileSync, mkdirSync, rmdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash, atomicWrite } from './envelope.mjs';
import { validate } from './schema.mjs';
import { leaseCheck } from './lease.mjs';

// Codex impl r12 🔴: runId must be a single safe path segment — a '../' (or slash) runId would make runDir
// resolve outside the project root, and ALL state/event/episode/handoff writers build paths from runDir.
export function runDir(root, runId) {
  if (typeof runId !== 'string' || runId.length === 0 || runId === '.' || runId === '..' || /[/\\]/.test(runId)) {
    throw new Error(`RUN_ID_INVALID: ${runId}`);
  }
  return join(root, '.deep-loop', 'runs', runId);
}
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
  // loop.json이 있는데 hash anchor가 없으면 = anchor 제거 공격/손상 → fail-closed (Codex impl 🔴1)
  if (!existsSync(hashPath(root, runId))) {
    throw new Error(`STATE_TAMPERED: ${runId} .loop.hash anchor missing`);
  }
  const stored = readFileSync(hashPath(root, runId), 'utf8').trim();
  if (contentHash(raw) !== stored) {
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

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function setPath(obj, path, value) {
  const keys = path.split('.'); const last = keys.pop();
  for (const k of [...keys, last]) if (UNSAFE_KEYS.has(k)) throw new Error(`FIELD_FORBIDDEN: unsafe key ${k}`);
  const t = keys.reduce((o, k) => (o[k] ??= {}), obj);
  t[last] = value;
}

export function patch(root, runId, field, value, { fence } = {}) {
  if (classifyPatch(field, value) !== 'allow') throw new Error(`FIELD_FORBIDDEN: ${field}`);
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    if (fence) { const r = leaseCheck(data, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    setPath(data, field, value);
    writeState(root, runId, data);
  });
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function withLock(root, runId, fn, { ttlMs = 30000, retries = 100, backoffMs = 5 } = {}) {
  const lock = join(runDir(root, runId), '.lock');
  let acquired = false;
  for (let i = 0; i < retries && !acquired; i++) {
    try { mkdirSync(lock); acquired = true; break; } catch { /* held */ }
    // stale-lock 복구: 소유 프로세스가 죽어 남은 락은 TTL 후 회수
    try { if (Date.now() - statSync(lock).mtimeMs > ttlMs) { rmdirSync(lock); continue; } } catch { /* lock vanished */ }
    sleepMs(backoffMs);
  }
  if (!acquired) throw new Error(`LOCK_BUSY: ${runId}`);
  try { return fn(); } finally { try { rmdirSync(lock); } catch {} }
}

// Fail-closed safety pause (spec §9 / §1.2): set status=paused atomically under the lock.
// Used when measured headless usage cannot be enforced after a resume takeover. Safety stop, not a business mutation.
export function pauseRun(root, runId, reason) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    if (data.status !== 'paused') {
      data.status = 'paused';
      data.pause_reason = reason || 'fail-closed';
      writeState(root, runId, data);
    }
  });
}
