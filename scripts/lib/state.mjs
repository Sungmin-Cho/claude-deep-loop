import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path, { join } from 'node:path';
import { contentHash, atomicWrite } from './envelope.mjs';
import { durableAtomicWrite, flushDirectory } from './atomic-write.mjs';
import {
  canonicalNonSymlinkDirectory,
  captureStableFileIdentity,
  matchingStableFileIdentity,
} from './fs-safe.mjs';
import { validate } from './schema.mjs';
import { leaseCheck } from './lease.mjs';
import {
  appendAnchored,
  captureReconciledRootRecoverySnapshot as captureReconciledRootRecoverySnapshotImpl,
  captureReconciledRunSet as captureReconciledRunSetImpl,
  captureReconciledRunSnapshot as captureReconciledRunSnapshotImpl,
  MUTATION_TURN_FLOOR,
  withReconciledMutationLock as withReconciledMutationLockImpl,
  withReconciledRootRecoveryLock as withReconciledRootRecoveryLockImpl,
} from './integrity.mjs';
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

// v1.10 마이그레이션 — hash 검증 직후 in-memory 전용 (디스크·.loop.hash는 첫 writeState까지 불변).
// 일반 read/root-recovery/rebind-validate 세 경로 전부 이 리더를 지나므로 여기가 유일 진입점 (스펙 §7).
// 결정적·내용 기반(주입 시계 불필요). 반환 data(0.3.0)와 반환 hash(디스크 0.2.0)는 content-hash 등가가 아니다.
function migrateLoopStateInPlace(data) {
  if (!data || typeof data !== 'object') return;
  // 마이그레이션은 **0.2.0 레거시에만** 적용한다 — 버전 무관 기본값 주입은 필드가 결손된 불량 0.3.0
  // 상태를 몰래 치유해 SCHEMA_INVALID 대신 유효로 읽히게 만든다(다음 mutation이 치유본을 지속화).
  // 0.3.0/미지 버전은 무접촉 → validate가 정상적으로 거부한다.
  if (data.schema_version !== '0.2.0') return;
  data.schema_version = '0.3.0';
  if (data.autonomy && data.autonomy.continuation_policy === undefined) {
    data.autonomy.continuation_policy = 'rotate-per-unit';
  }
  if (data.session_chain) {
    if (data.session_chain.consumed_milestones === undefined) data.session_chain.consumed_milestones = [];
    if (data.session_chain.lease && data.session_chain.lease.handoff_trigger === undefined) {
      data.session_chain.lease.handoff_trigger = null;
    }
  }
}

export function parseHashVerifiedStateBytes(root, runId, loopBytes, hashBytes, {
  requireSchema = false,
  requireProjectBinding = true,
} = {}) {
  const raw = Buffer.isBuffer(loopBytes) ? loopBytes.toString('utf8') : String(loopBytes);
  // loop.json이 있는데 hash anchor가 없으면 = anchor 제거 공격/손상 → fail-closed (Codex impl 🔴1)
  if (hashBytes == null) {
    throw new Error(`STATE_TAMPERED: ${runId} .loop.hash anchor missing`);
  }
  const stored = (Buffer.isBuffer(hashBytes) ? hashBytes.toString('utf8') : String(hashBytes)).trim();
  if (contentHash(raw) !== stored) {
    throw new Error(`STATE_TAMPERED: ${runId} loop.json content-hash mismatch`);
  }
  const data = JSON.parse(raw);
  migrateLoopStateInPlace(data);
  if (requireSchema) {
    const checked = validate(data);
    if (!checked.ok) throw new Error(`SCHEMA_INVALID: ${checked.errors.join('; ')}`);
  }
  if (requireProjectBinding) assertProjectRootBinding(root, data);
  return { data, hash: stored };
}

function readHashVerifiedState(root, runId) {
  const raw = readFileSync(loopPath(root, runId));
  const anchor = existsSync(hashPath(root, runId)) ? readFileSync(hashPath(root, runId)) : null;
  return parseHashVerifiedStateBytes(root, runId, raw, anchor, { requireProjectBinding: false });
}

export function readStateForRootRecovery(root, runId) {
  return readHashVerifiedState(root, runId);
}

export function readState(root, runId) {
  const state = readHashVerifiedState(root, runId);
  assertProjectRootBinding(root, state.data);
  return state;
}

export function captureReconciledRunSnapshot(...args) {
  return captureReconciledRunSnapshotImpl(...args);
}

export function captureReconciledRunSet(...args) {
  return captureReconciledRunSetImpl(...args);
}

export function captureReconciledRootRecoverySnapshot(...args) {
  return captureReconciledRootRecoverySnapshotImpl(...args);
}

export function withReconciledMutationLock(...args) {
  return withReconciledMutationLockImpl(...args);
}

export function withReconciledRootRecoveryLock(...args) {
  return withReconciledRootRecoveryLockImpl(...args);
}

export function writeState(root, runId, data, { atomicWriteFn = atomicWrite } = {}) {
  assertProjectRootBinding(root, data);
  const v = validate(data);
  if (!v.ok) throw new Error(`SCHEMA_INVALID: ${v.errors.join('; ')}`);
  data.updated_at = new Date().toISOString();
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
  if (classifyPatch(field, value) !== 'allow') throw new Error(`FIELD_FORBIDDEN: ${field}`);
  // #3 (R1 Fix 2): route through appendAnchored so a whitelisted patch (which can flip active_workstreams — a
  // finish proof input — and non-terminal episode/workstream status — a next-action routing input) is BOTH
  // tamper-evident (was a silent withLock+writeState) AND floor-charged. The value is NOT recorded in the event
  // (may be large/sensitive) — only the field path. All throwing guards live in preCheck (fresh loop, pre-append).
  return appendAnchored(root, runId, { type: 'state-patch', data: { field } },
    (loop) => { setPath(loop, field, value); },
    (loop) => {
      if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
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
    { floor: MUTATION_TURN_FLOOR });
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

const LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCK_OWNER_KEYS = [
  'protocol_version', 'token', 'pid', 'hostname', 'acquired_at_ms', 'heartbeat_at_ms', 'lock_identity',
];

function canonicalHostname(value) {
  if (typeof value !== 'string') throw new Error('LOCK_HOSTNAME_INVALID');
  const normalized = value.normalize('NFC').trim().toLowerCase();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('LOCK_HOSTNAME_INVALID');
  return normalized;
}

function boundedTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('LOCK_TIME_INVALID');
  return value;
}

function validLockOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value)) !== JSON.stringify(LOCK_OWNER_KEYS)
    || value.protocol_version !== 1 || !LOCK_TOKEN.test(value.token || '')
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.hostname !== 'string' || canonicalHostname(value.hostname) !== value.hostname
    || !Number.isSafeInteger(value.acquired_at_ms) || value.acquired_at_ms < 0
    || !Number.isSafeInteger(value.heartbeat_at_ms) || value.heartbeat_at_ms < value.acquired_at_ms
    || !value.lock_identity || typeof value.lock_identity !== 'object') return false;
  return matchingStableFileIdentity(value.lock_identity, value.lock_identity);
}

function readLockOwner(ownerPath, readFn = readFileSync) {
  try {
    const owner = JSON.parse(readFn(ownerPath, 'utf8'));
    return validLockOwner(owner) ? owner : null;
  } catch {
    return null;
  }
}

function defaultProbePid(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function sameOwner(left, right) {
  return left && right && JSON.stringify(left) === JSON.stringify(right);
}

export function withLock(root, runId, fn, {
  ttlMs = LOCK_STALE_TTL_MS,
  retries = 100,
  backoffMs = 5,
  nowFn = Date.now,
  hostnameFn = hostname,
  pid = process.pid,
  tokenFactory = randomUUID,
  probePid = defaultProbePid,
  sleepFn = sleepMs,
  faultAt = () => {},
  mkdirFn = mkdirSync,
  renameFn = renameSync,
  removeFn = rmSync,
  lstatFn = lstatSync,
  readFileFn = readFileSync,
  readdirFn = readdirSync,
  durableWriteFn = durableAtomicWrite,
  flushDirectoryFn = flushDirectory,
  platform = process.platform,
} = {}) {
  const lexicalRunDir = runDir(root, runId);
  const lockedRunDir = (() => {
    try {
      const canonical = realpathSync(lexicalRunDir);
      return statSync(canonical).isDirectory() ? canonical : null;
    } catch { return null; }
  })();
  if (!lockedRunDir) throw new Error('LOCK_RUN_INVALID');
  const lock = join(lexicalRunDir, '.lock');
  const ownerPath = join(lock, 'owner.json');
  const localHostname = canonicalHostname(hostnameFn());
  const token = String(tokenFactory()).toLowerCase();
  if (!LOCK_TOKEN.test(token) || !Number.isSafeInteger(pid) || pid <= 0
    || !Number.isInteger(ttlMs) || ttlMs < 0 || !Number.isInteger(retries) || retries < 1
    || !Number.isFinite(backoffMs) || backoffMs < 0) throw new Error('LOCK_OPTIONS_INVALID');
  let acquired = false;
  let lockIdentity = null;
  let owner = null;

  const inspectOwned = (path = lock, expectedOwner = owner, expectedIdentity = lockIdentity) => {
    try {
      const lexical = lstatFn(path, { bigint: true });
      if (lexical.isSymbolicLink?.() || !lexical.isDirectory?.()) return false;
      const identity = captureStableFileIdentity(path, { lstatFn });
      if (!matchingStableFileIdentity(identity, expectedIdentity)) return false;
      const observed = (() => {
        try {
          const parsed = JSON.parse(readFileFn(join(path, 'owner.json'), 'utf8'));
          return validLockOwner(parsed) ? parsed : null;
        } catch { return null; }
      })();
      return sameOwner(observed, expectedOwner);
    } catch {
      return false;
    }
  };

  const tryReclaim = () => {
    let observedIdentity;
    let observedOwner;
    try {
      const lexical = lstatFn(lock, { bigint: true });
      if (lexical.isSymbolicLink?.() || !lexical.isDirectory?.()) return false;
      observedIdentity = captureStableFileIdentity(lock, { lstatFn });
      observedOwner = readLockOwner(ownerPath, readFileFn);
    } catch {
      return false;
    }
    if (!observedOwner || !matchingStableFileIdentity(observedOwner.lock_identity, observedIdentity)
      || observedOwner.hostname !== localHostname) return false;
    const now = boundedTime(nowFn());
    if (now - observedOwner.heartbeat_at_ms <= ttlMs) return false;
    let liveness = 'unknown';
    try { liveness = probePid(observedOwner.pid); } catch { liveness = 'unknown'; }
    if (liveness !== 'dead') return false;
    if (!inspectOwned(lock, observedOwner, observedIdentity)) return false;
    const quarantine = `${lock}.quarantine-${observedOwner.token}`;
    try {
      renameFn(lock, quarantine);
    } catch {
      return false;
    }
    faultAt('reclaim:quarantined');
    flushDirectoryFn(path.dirname(lock), { platform });
    faultAt('reclaim:quarantine-parent-flushed');
    if (!inspectOwned(quarantine, observedOwner, observedIdentity)) {
      throw new Error('LOCK_RECLAIM_CONFLICT');
    }
    removeFn(quarantine, { recursive: true, force: false });
    faultAt('reclaim:deleted');
    flushDirectoryFn(path.dirname(lock), { platform });
    faultAt('reclaim:delete-parent-flushed');
    return true;
  };

  const resumeReclaim = () => {
    const parent = path.dirname(lock);
    const prefix = `${path.basename(lock)}.quarantine-`;
    let names;
    try {
      names = readdirFn(parent)
        .filter(name => name.startsWith(prefix));
    } catch {
      return;
    }
    if (names.length > 1) throw new Error('LOCK_RECLAIM_CONFLICT');
    if (names.length === 0) return;
    const quarantine = join(parent, names[0]);
    const observedOwner = readLockOwner(join(quarantine, 'owner.json'), readFileFn);
    if (!observedOwner || names[0] !== `${prefix}${observedOwner.token}`) throw new Error('LOCK_RECLAIM_CONFLICT');
    const observedIdentity = captureStableFileIdentity(quarantine, { lstatFn });
    const now = boundedTime(nowFn());
    let liveness = 'unknown';
    try { liveness = probePid(observedOwner.pid); } catch { liveness = 'unknown'; }
    if (!matchingStableFileIdentity(observedOwner.lock_identity, observedIdentity)
      || observedOwner.hostname !== localHostname || now - observedOwner.heartbeat_at_ms <= ttlMs
      || liveness !== 'dead' || !inspectOwned(quarantine, observedOwner, observedIdentity)) {
      throw new Error('LOCK_RECLAIM_CONFLICT');
    }
    flushDirectoryFn(parent, { platform });
    faultAt('reclaim:resumed-quarantine-parent-flushed');
    if (!inspectOwned(quarantine, observedOwner, observedIdentity)) {
      throw new Error('LOCK_RECLAIM_CONFLICT');
    }
    removeFn(quarantine, { recursive: true, force: false });
    faultAt('reclaim:resumed-deleted');
    flushDirectoryFn(parent, { platform });
    faultAt('reclaim:resumed-delete-parent-flushed');
  };

  for (let i = 0; i < retries && !acquired; i++) {
    resumeReclaim();
    try {
      mkdirFn(lock, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (tryReclaim()) continue;
    sleepFn(backoffMs);
  }
  if (!acquired) throw new Error(`LOCK_BUSY: ${runId}`);
  try {
    lockIdentity = captureStableFileIdentity(lock, { lstatFn });
    const acquiredAt = boundedTime(nowFn());
    owner = {
      protocol_version: 1,
      token,
      pid,
      hostname: localHostname,
      acquired_at_ms: acquiredAt,
      heartbeat_at_ms: acquiredAt,
      lock_identity: lockIdentity,
    };
    durableWriteFn(ownerPath, JSON.stringify(owner), { platform });
    faultAt('acquire:owner-durable');
    if (!inspectOwned()) throw new Error('LOCK_OWNERSHIP_LOST');

    const assertRunBinding = (expectedRunDir) => {
      if (expectedRunDir === undefined) return;
      const canonicalExpected = canonicalNonSymlinkDirectory(expectedRunDir);
      if (!canonicalExpected || canonicalExpected !== lockedRunDir) throw new Error('LOCK_RUN_MISMATCH');
    };
    const assertOwned = (expectedRunDir) => {
      assertRunBinding(expectedRunDir);
      if (!inspectOwned()) throw new Error('LOCK_OWNERSHIP_LOST');
      return true;
    };
    const renew = (expectedRunDir) => {
      assertOwned(expectedRunDir);
      faultAt('renew:validated');
      const heartbeat = boundedTime(nowFn());
      if (heartbeat < owner.heartbeat_at_ms) throw new Error('LOCK_TIME_INVALID');
      owner = { ...owner, heartbeat_at_ms: heartbeat };
      durableWriteFn(ownerPath, JSON.stringify(owner), { platform });
      assertOwned(expectedRunDir);
      return true;
    };
    const guard = Object.freeze({ token, assertOwned, renew });
    return fn(guard);
  } finally {
    if (owner && lockIdentity && inspectOwned()) {
      try {
        faultAt('release:validated');
        if (!inspectOwned()) throw new Error('LOCK_OWNERSHIP_LOST');
        const quarantine = `${lock}.release-${token}`;
        renameFn(lock, quarantine);
        faultAt('release:quarantined');
        flushDirectoryFn(path.dirname(lock), { platform });
        faultAt('release:quarantine-parent-flushed');
        if (inspectOwned(quarantine, owner, lockIdentity)) {
          removeFn(quarantine, { recursive: true, force: false });
          faultAt('release:deleted');
          flushDirectoryFn(path.dirname(lock), { platform });
          faultAt('release:delete-parent-flushed');
        }
      } catch { /* ownership loss preserves evidence and never removes a successor */ }
    }
  }
}

// Two-mode safety pause (spec §9 / §1.2). Uses appendAnchored for event-log consistency.
// mode='preserve' (default): sets status=paused, keeps lease.state/handoff_child_run_id intact,
//   sets lease.resume_policy='human' + lease.expires_at=null.
// mode='rollback': additionally resets lease to active/idle and clears all handoff fields.
// preCheck: owner/generation fence. Does NOT apply releasing carve-out (pause is privileged).
export function pauseRun(root, runId, { reason, mode = 'preserve', expect, now = Date.now() } = {}) {
  return appendAnchored(root, runId, { type: 'run-paused', data: { reason: reason || 'fail-closed', mode } },
    (loop) => {
      loop.status = 'paused';
      loop.pause_reason = reason || 'fail-closed';
      if (mode === 'rollback') {
        loop.session_chain.lease = {
          ...loop.session_chain.lease,
          state: 'active',
          handoff_phase: 'idle',
          handoff_child_run_id: null,
          handoff_idempotency_key: null,
          handoff_trigger: null,
          expires_at: null,
        };
      } else {
        // preserve: keep lease.state + handoff_child_run_id intact; set resume_policy + expires_at
        loop.session_chain.lease = {
          ...loop.session_chain.lease,
          resume_policy: 'human',
          expires_at: null,
        };
      }
    },
    (loop) => {
      if (expect) {
        const lease = loop.session_chain?.lease;
        if (!lease || lease.owner_run_id !== expect.owner || lease.generation !== expect.generation) {
          throw new Error('LEASE_FENCED: pauseRun wrong generation');
        }
      }
      // Terminal guard (spec §1.2 / acquireLease mirror): completed/stopped runs must never be demoted to paused.
      // Checked after fence so that LEASE_FENCED fires first when both conditions hold —
      // drive-headless re-reads state to detect terminal after catching LEASE_FENCED.
      if (loop.status === 'completed' || loop.status === 'stopped') {
        throw new Error('RUN_TERMINAL: pauseRun');
      }
    }
  );
}
