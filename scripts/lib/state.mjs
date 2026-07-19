import { readFileSync, writeFileSync, mkdirSync, rmdirSync, existsSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { contentHash, atomicWrite } from './envelope.mjs';
import { validate } from './schema.mjs';
import { appTransportBinding, leaseCheck } from './lease.mjs';
import { appendAnchored, assertVerifiedRunSnapshot, intentField, mutationIntentDigest,
  MUTATION_TURN_FLOOR, readLines, statePatchIntent, withVerifiedMutationLock }
  from './integrity.mjs';
import { assertProjectRootBinding } from './project-root.mjs';
import { ancestorPaths } from './path-portable.mjs';

export const LOCK_STALE_TTL_MS = 30_000;

// R5 high-2: 상향탐색을 worktree 컨벤션(.claude/worktrees | .worktrees)으로 **한정**한다.
// 무한정 walk 는 부모 run 밑의 nested repo/submodule 을 부모 run 에 잘못 바인딩(격리 회귀)시킨다.
// cwd 가 <root>/.claude/worktrees/<slug>/... (또는 .worktrees) 안일 때만 그 부모 <root>(.deep-loop/current 보유)를 반환;
// 그 외에는 startDir 그대로(기존 process.cwd() 동작과 동일 — 하위호환).
export function findRoot(startDir, { pathApi = path, existsSync: markerExists = existsSync } = {}) {
  const conventionComponent = value => pathApi.sep === '\\' ? value.toLowerCase() : value;
  for (const current of ancestorPaths(startDir, { pathApi })) {
    const parent = pathApi.dirname(current);
    const currentName = conventionComponent(pathApi.basename(current));
    const parentName = conventionComponent(pathApi.basename(parent));
    const isClaudeWt = parentName === '.claude' && currentName === 'worktrees';
    const isPlainWt = currentName === '.worktrees';
    if (isClaudeWt || isPlainWt) {
      const base = isClaudeWt ? pathApi.dirname(parent) : parent;
      if (markerExists(pathApi.join(base, '.deep-loop', 'current'))) return base;
      // FIX H: 첫 번째 컨벤션 매치에 마커 없어도 break하지 말고 계속 탐색 — 중첩 컨벤션 경로에서 외부 run을 찾을 수 있음.
      // 어떤 컨벤션 세그먼트도 마커를 가진 base를 제공하지 못하면 루프 종료 후 startDir 반환.
      // continue
    }
  }
  return startDir;
}

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
const TERMINAL_EPISODE = ['done', 'approved', 'rejected', 'abandoned'];
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

function readHashVerifiedState(root, runId) {
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

export function readStateForRootRecovery(root, runId) {
  return readHashVerifiedState(root, runId);
}

export function readState(root, runId) {
  const state = readHashVerifiedState(root, runId);
  assertProjectRootBinding(root, state.data);
  return state;
}

export function writeState(root, runId, data,
  { atomicWriteFn = atomicWrite, stampUpdatedAt = true } = {}) {
  assertProjectRootBinding(root, data);
  if (stampUpdatedAt) data.updated_at = new Date().toISOString();
  assertVerifiedRunSnapshot(root, runId, data);
  const v = validate(data);
  if (!v.ok) throw new Error(`SCHEMA_INVALID: ${v.errors.join('; ')}`);
  const raw = JSON.stringify(data, null, 2);
  atomicWriteFn(loopPath(root, runId), raw);
  atomicWriteFn(hashPath(root, runId), contentHash(raw));
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function setPath(obj, path, value) {
  const keys = path.split('.'); const last = keys.pop();
  for (const k of [...keys, last]) if (UNSAFE_KEYS.has(k)) throw new Error(`FIELD_FORBIDDEN: unsafe key ${k}`);
  const t = keys.reduce((o, k) => (o[k] ??= {}), obj);
  t[last] = value;
}

export function patch(root, runId, field, value, { fence } = {}) {
  if (!fence || typeof fence.owner !== 'string'
      || !Number.isSafeInteger(fence.generation) || fence.generation < 1) {
    throw new Error('FENCE_REQUIRED: patch');
  }
  if (classifyPatch(field, value) !== 'allow') throw new Error(`FIELD_FORBIDDEN: ${field}`);
  // #3 (R1 Fix 2): route through appendAnchored so a whitelisted patch (which can flip active_workstreams — a
  // finish proof input — and non-terminal episode/workstream status — a next-action routing input) is BOTH
  // tamper-evident (was a silent withLock+writeState) AND floor-charged. The value is NOT recorded in the event
  // (may be large/sensitive) — only the field path. All throwing guards live in preCheck (fresh loop, pre-append).
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const intentDigest = statePatchIntent(callerBinding, field, value);
  return appendAnchored(root, runId, { type: 'state-patch', data: { field } },
    (loop) => { setPath(loop, field, value); },
    (loop) => {
      if (fence) {
        const identity = leaseCheck(loop, { ...fence, intent: 'lease' });
        if (!identity.ok) throw new Error('LEASE_FENCED: ' + identity.reason);
        if (appTransportBinding(loop)) throw new Error('APP_TRANSPORT_OWNED: state-patch');
        const business = leaseCheck(loop, fence);
        if (!business.ok) throw new Error('LEASE_FENCED: ' + business.reason);
      }
      const im = field.match(/^(episodes|workstreams)\.(\d+)\.(.+)$/);
      if (im) {
        const [, arr, idxStr, sub] = im;
        if (!/^(0|[1-9]\d*)$/.test(idxStr)) throw new Error(`FIELD_FORBIDDEN: ${field} (non-canonical index)`);
        const list = loop[arr]; const idx = Number(idxStr);
        if (!Array.isArray(list) || idx >= list.length || list[idx] == null) throw new Error(`FIELD_FORBIDDEN: ${field} (index out of range)`);
        if (sub === 'status') {
          const term = arr === 'episodes' ? TERMINAL_EPISODE : TERMINAL_WORKSTREAM;
          if (term.includes(list[idx].status)) throw new Error(`FIELD_FORBIDDEN: ${field} (terminal status immutable)`);
        }
      }
      // impl-R2 Fix 3: pre-validate the POST-patch candidate here (before the event append). Otherwise an invalid
      // whitelisted value (e.g. active_workstreams := "bad") would let appendEvent commit while writeState's schema
      // validate throws afterwards — leaving the event-log tail ahead of the stored anchor → LOG_TAMPERED on the
      // next write (run brick). setPath's unsafe-key guard also fires here, before any append.
      const candidate = structuredClone(loop);
      setPath(candidate, field, value);
      const sv = validate(candidate);
      if (!sv.ok) throw new Error(`SCHEMA_INVALID: ${sv.errors.join('; ')}`);
    },
    { floor: MUTATION_TURN_FLOOR, callerBinding, intentDigest,
      fenceError: 'LEASE_FENCED: patch' });
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function withLock(root, runId, fn, { ttlMs = LOCK_STALE_TTL_MS, retries = 100, backoffMs = 5 } = {}) {
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

// Two-mode safety pause (spec §9 / §1.2). Uses appendAnchored for event-log consistency.
// mode='preserve' (default): sets status=paused, keeps lease.state/handoff_child_run_id intact,
//   sets lease.resume_policy='human' + lease.expires_at=null.
// mode='rollback': additionally resets lease to active/idle and clears all handoff fields.
// preCheck: owner/generation fence. Does NOT apply releasing carve-out (pause is privileged).
function pauseFence(expect) {
  return loop => {
    const lease = loop.session_chain?.lease;
    if (!lease || lease.owner_run_id !== expect.owner || lease.generation !== expect.generation) {
      throw new Error('LEASE_FENCED: pauseRun wrong generation');
    }
  };
}

function exactPauseStateProjection(loop, reason, mode) {
  const lease = loop.session_chain?.lease;
  if (loop.status !== 'paused' || loop.pause_reason !== reason) return false;
  return mode === 'rollback'
    ? lease?.state === 'active' && lease.handoff_phase === 'idle'
      && lease.handoff_child_run_id == null && lease.handoff_idempotency_key == null
      && lease.expires_at == null
    : lease?.resume_policy === 'human' && lease.expires_at == null;
}

function exactPauseEvent(event, reason, mode) {
  const exactKeys = (value, keys) => JSON.stringify(Object.keys(value ?? {}).sort())
    === JSON.stringify([...keys].sort());
  return event?.type === 'run-paused'
    && exactKeys(event.data, ['mode', 'reason'])
    && event.data.reason === reason && event.data.mode === mode;
}

function pauseReplayProjection(loop, lines, reason, mode) {
  const matching = lines.map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'run-paused'
      && event.data?.reason === reason && event.data?.mode === mode);
  if (matching.length === 0) return 'new';
  const { event, index } = matching.at(-1);
  const immediate = matching.length === 1 && index === lines.length - 1
    && exactPauseEvent(event, reason, mode)
    && event.seq === loop.event_log_head?.seq
    && event.checksum === loop.event_log_head?.checksum
    && exactPauseStateProjection(loop, reason, mode);
  return immediate ? 'exact' : 'changed';
}

export function pauseRun(root, runId, {
  reason, mode = 'preserve', expect, now = Date.now(),
} = {}) {
  if (!expect || typeof expect.owner !== 'string'
      || !Number.isSafeInteger(expect.generation)) throw new Error('FENCE_REQUIRED: pauseRun');
  const pauseReason = reason || 'fail-closed';
  const callerBinding = { owner: expect.owner, generation: expect.generation };
  const intentDigest = mutationIntentDigest('run-pause', callerBinding, {
    request_digest: intentField('run-pause-request', { reason: pauseReason, mode }),
  });
  const fenceCheck = pauseFence(expect);
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'LEASE_FENCED: pauseRun' }, mutation => {
    const loop = mutation.readVerifiedState({ fenceCheck }).data;
    const replay = pauseReplayProjection(loop, readLines(root, runId), pauseReason, mode);
    if (replay === 'exact') return undefined;
    if (replay === 'changed') throw new Error('STATE_RESPONSE_PROJECTION_CHANGED');
    return mutation.appendAnchored(
      { type: 'run-paused', data: { reason: pauseReason, mode } },
      candidate => {
        candidate.status = 'paused';
        candidate.pause_reason = pauseReason;
        if (mode === 'rollback') {
          candidate.session_chain.lease = {
            ...candidate.session_chain.lease,
            state: 'active',
            handoff_phase: 'idle',
            handoff_child_run_id: null,
            handoff_idempotency_key: null,
            expires_at: null,
          };
        } else {
          // preserve: keep lease.state + handoff_child_run_id intact; set resume_policy + expires_at
          candidate.session_chain.lease = {
            ...candidate.session_chain.lease,
            resume_policy: 'human',
            expires_at: null,
          };
        }
      }, candidate => {
        // Terminal guard (spec §1.2 / acquireLease mirror): completed/stopped runs must never be
        // demoted to paused. The split fence runs before verified proof, then these business guards.
        if (candidate.status === 'completed' || candidate.status === 'stopped') {
          throw new Error('RUN_TERMINAL: pauseRun');
        }
        if (appTransportBinding(candidate)) throw new Error('APP_TRANSPORT_OWNED: pauseRun');
      }, { nowFn: () => now, fenceCheck });
  });
}
