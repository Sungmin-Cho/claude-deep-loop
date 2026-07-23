import { statSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash, ulid } from './envelope.mjs';
import { runtimeFence } from './runtime.mjs';
import { runDir, writeState, withReconciledMutationLock } from './state.mjs';
import { nextAction } from './next-action.mjs';
import { projectRootDigest } from './project-root.mjs';

const PHASE_ORDER = { idle: 0, reserved: 1, emitted: 2, spawned: 3, acquired: 4 };

export function deriveIdempotencyKey(ownerRunId, ownerGeneration, triggerReason) {
  return contentHash(`${ownerRunId}|${ownerGeneration}|${triggerReason}`).slice(0, 16);
}

export function sameBoundaryEvent(left, right) {
  return left != null
    && typeof left === 'object'
    && !Array.isArray(left)
    && JSON.stringify(Object.keys(left).sort()) === JSON.stringify(['checksum', 'seq'])
    && right != null
    && typeof right === 'object'
    && !Array.isArray(right)
    && JSON.stringify(Object.keys(right).sort()) === JSON.stringify(['checksum', 'seq'])
    && Number.isSafeInteger(left.seq)
    && left.seq > 0
    && left.seq === right?.seq
    && /^[0-9a-f]{64}$/.test(left.checksum || '')
    && left.checksum === right?.checksum;
}

export function boundaryHandoffTopologyError(data) {
  const lease = data?.session_chain?.lease || {};
  if (lease.takeover_kind !== 'boundary-handoff') return null;
  const child = (data.session_chain?.sessions || [])
    .find(session => session.run_id === lease.handoff_child_run_id);
  const parent = child && (data.session_chain.sessions || [])
    .find(session => session.run_id === child.parent_run_id);
  const rootDigest = projectRootDigest(data.project?.root);
  if (!child
    || !parent
    || parent.superseded_by !== child.run_id
    || parent.scope?.kind !== 'workstream'
    || parent.scope.closed_at == null
    || parent.scope.superseded_at == null
    || !sameBoundaryEvent(parent.scope.terminal_event, lease.handoff_boundary_event)
    || child.parent_run_id !== parent.run_id
    || !sameBoundaryEvent(child.parent_boundary_event, lease.handoff_boundary_event)
    || child.project_binding_generation !== data.project?.binding_generation
    || child.project_root_digest !== rootDigest
    || lease.handoff_project_binding_generation !== data.project?.binding_generation
    || lease.handoff_project_root_digest !== rootDigest
    || child.scope?.kind !== 'workstream'
    || child.scope.workstream_id !== null
    || child.scope.terminal_event !== null
    || child.scope.closed_at !== null
    || child.scope.superseded_at !== null) {
    return 'boundary-topology-invalid';
  }
  return null;
}

function boundaryReservationError(data, boundaryEvent, now) {
  if (!sameBoundaryEvent(boundaryEvent, boundaryEvent)) return 'BOUNDARY_EVENT_INVALID';
  const lease = data.session_chain?.lease || {};
  const owner = (data.session_chain?.sessions || [])
    .find(session => session.run_id === lease.owner_run_id);
  const scope = owner?.scope;
  if (scope?.kind !== 'workstream'
    || scope.closed_at == null
    || scope.superseded_at != null
    || !sameBoundaryEvent(scope.terminal_event, boundaryEvent)) {
    return 'BOUNDARY_EVENT_MISMATCH';
  }
  const workstream = (data.workstreams || [])
    .find(item => item.id === scope.workstream_id);
  if (!workstream || !(workstream.terminal_events || [])
    .some(event => sameBoundaryEvent(event, boundaryEvent))) {
    return 'BOUNDARY_EVENT_MISMATCH';
  }
  const action = nextAction(data, { now }).action;
  if (action?.type === 'await_human' && action.reason === 'budget') return 'BUDGET_BLOCKED';
  if (action?.type === 'await_human' && action.reason === 'breaker') return 'BREAKER_BLOCKED';
  if (action?.type === 'finish') return 'FINISH_REQUIRED';
  if (action?.type !== 'handoff'
    || action.reason !== 'workstream-terminal'
    || !sameBoundaryEvent(action.boundary_event, boundaryEvent)) {
    return 'BOUNDARY_EVENT_MISMATCH';
  }
  return null;
}

// 펜싱 가드 — 읽기를 제외한 모든 커널 mutating 경로가 진입 전에 호출 (spec §9.1).
// RUN_PAUSED gate: paused 상태에서 업무 write 거부. 예외 intent: 'recover', 'resume', 'breaker-reset'.
export function leaseCheck(loop, { owner, generation, runtime, intent = 'business' } = {}) {
  if (runtime !== undefined) {
    const fence = runtimeFence(loop, runtime);
    if (!fence.ok) return fence;
  }
  const lease = loop?.session_chain?.lease;
  if (!lease) return { ok: false, reason: 'no-lease' };
  if (lease.owner_run_id !== owner) return { ok: false, reason: 'owner-mismatch' };
  if (lease.generation !== generation) return { ok: false, reason: 'generation-mismatch' };
  // v1.6 terminal guard (spec §2.1): terminal은 one-way — 전 intent 거부(예외 없음, 사람 확정 2026-07-09).
  // lease.state 체크보다 앞이어야 terminal+released/terminal+releasing에서도 reason이 안정적으로
  // RUN_TERMINAL이다(r3 🟡3). fence(owner/generation) 불일치는 위에서 선착(fence-first, pauseRun 전례).
  if (loop.status === 'completed' || loop.status === 'stopped') return { ok: false, reason: 'RUN_TERMINAL' };
  if (lease.state === 'released') return { ok: false, reason: 'lease-released' };
  // 부모 carve-out: releasing 중 업무 write 거부; 자기 lease 관리(intent='lease')와 비용 회계(intent='accounting')만 허용.
  if (lease.state === 'releasing' && intent !== 'lease' && intent !== 'accounting') return { ok: false, reason: 'lease-releasing-carveout' };
  // Codex r2 🔴2: expires_at 로 active 소유자를 fence 하지 않는다 — 살아있는 소유자가 TTL(15분) 후 자기 write 에서
  // 죽으면 안 됨. stale 소유자(자식이 인수해 generation 이 올라간 경우)는 generation-mismatch 로 이미 펜싱된다.
  // expires_at 는 오직 acquireLease 의 takeover 판단(releasing 크래시)에만 쓰인다.
  // RUN_PAUSED: paused 상태 → 업무/lease write 차단. 인간 전용 경로 외에, 이미 소비된
  // checker turn을 최종 import 후 기록하는 matching accounting만 허용한다. 상단 owner/generation,
  // terminal, released/releasing 가드를 모두 통과해야 하므로 소유권이나 업무 권한은 넓어지지 않는다.
  if (loop.status === 'paused' && intent !== 'accounting'
    && intent !== 'recover' && intent !== 'resume' && intent !== 'breaker-reset') {
    return { ok: false, reason: 'RUN_PAUSED' };
  }
  return { ok: true, reason: 'ok' };
}

// Runtime-fenced CAS 인수: released 또는 stale(expired)만, generation === expectGeneration. 성공 시 generation+1.
export function acquireLease(root, runId, { owner, expectGeneration, runtime, now = Date.now() }) {
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('INVALID_OWNER');
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    const runtimeResult = runtimeFence(data, runtime);
    if (!runtimeResult.ok) return runtimeResult;
    const lease = data.session_chain.lease;
    // 같은 owner 가 이미 active 면 멱등 (active 는 만료 deadline 이 없다 — Codex r2 🔴2)
    if (lease.owner_run_id === owner && lease.state === 'active') {
      // v1.6 (spec §2.3-6, r5 P2-b): terminal+active(정상 finish 상태)에서 멱등 성공(already-owned)으로
      // 위장 금지 — resume이 소유권 경계에서 명확히 거부되어야 한다.
      if (data.status === 'stopped' || data.status === 'completed') {
        return { ok: false, generation: lease.generation, reason: 'run-terminal' };
      }
      return { ok: true, generation: lease.generation, reason: 'already-owned' };
    }
    if (lease.generation !== expectGeneration) {
      return { ok: false, generation: lease.generation, reason: 'generation-mismatch' };
    }
    // v1.6 (spec §2.3-6): generation CAS 직후·takeable 체크 앞 — stale expectGeneration은 위에서
    // generation-mismatch(fence-first), generation이 맞는 terminal acquire는 여기서 안정적으로 run-terminal
    // (기존 위치는 takeable 뒤라 terminal+released가 lease-not-takeable/child-not-reserved로 새었다).
    // A recovered run is 'paused' (not terminal) so it remains acquireable.
    if (data.status === 'stopped' || data.status === 'completed') {
      return { ok: false, generation: lease.generation, reason: 'run-terminal' };
    }
    const topologyError = boundaryHandoffTopologyError(data);
    if (topologyError) return { ok: false, generation: lease.generation, reason: topologyError };
    // A boundary handoff is a durable one-child reservation, not a stale-lease
    // takeover invitation. TTL expiry is handled by the explicit recovery path;
    // it must never broaden this acquisition authority to an unrelated owner.
    if (lease.takeover_kind === 'boundary-handoff'
      && owner !== lease.handoff_child_run_id) {
      return { ok: false, generation: lease.generation, reason: 'child-not-reserved' };
    }
    // takeover 가능: released(정상 인수), releasing+expired(부모 크래시 복구), releasing+예약된child(handshake). active 절대 탈취 안 됨.
    const expired = lease.expires_at && now > Date.parse(lease.expires_at);
    const takeable = lease.state === 'released' || (lease.state === 'releasing' && expired) || (lease.state === 'releasing' && owner === lease.handoff_child_run_id);
    if (!takeable) return { ok: false, generation: lease.generation, reason: 'lease-not-takeable' };
    // Legacy handoffs reserved a specific child while the reservation was live.
    // Boundary handoffs were fenced above regardless of TTL.
    if (lease.state === 'released' && lease.handoff_child_run_id && owner !== lease.handoff_child_run_id && !expired) {
      return { ok: false, generation: lease.generation, reason: 'child-not-reserved' };
    }
    const waspaused = data.status === 'paused';
    const iso = new Date(now).toISOString();
    const {
      handoff_boundary_event: _boundaryEvent,
      handoff_project_binding_generation: _bindingGeneration,
      handoff_project_root_digest: _rootDigest,
      ...leaseAfterBoundary
    } = lease;
    data.session_chain.lease = {
      ...leaseAfterBoundary, owner_run_id: owner, generation: expectGeneration + 1,
      acquired_at: iso, expires_at: null,   // active 소유자는 deadline 없음 → 무기한 write (renewal 불필요)
      state: 'active', handoff_phase: 'acquired', handoff_idempotency_key: null, handoff_child_run_id: null,
      handoff_trigger: null, takeover_kind: null,
    };
    // Unpause (same transaction): covers BOTH preserve-resume (releasing+reserved-child) AND
    // recover-resume (released, no reserved child). This is the acquire-resume path that is
    // exempt from the RUN_PAUSED gate (Task 6 / leaseCheck intent='resume').
    if (waspaused) {
      data.status = 'running';
      data.pause_reason = null;
      data.session_chain.lease.resume_policy = null;
    }
    const childEntry = data.session_chain.sessions.find(s => s.run_id === owner);
    if (childEntry && !childEntry.started_at) childEntry.started_at = iso;
    const parentEntry = data.session_chain.sessions.find(s => s.superseded_by === owner);
    if (parentEntry) parentEntry.outcome = 'took_over';
    writeState(root, runId, data);
    return { ok: true, generation: expectGeneration + 1, reason: 'acquired' };
  });
}

export function releaseLease(root, runId, { owner, generation }) {
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('INVALID_OWNER');
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    const lease = data.session_chain.lease;
    if (lease.owner_run_id !== owner || lease.generation !== generation) return { ok: false, reason: 'fenced' };
    // Codex r3 🔴1: RUN_PAUSED — refuse to release when paused. An owner that got gate-blocked
    // (rollbackAndPause) must not call releaseLease to bypass the `recover --confirm` audit path.
    // leaseCheck intent='recover' (human-only) is the only way to resume from a paused run.
    if (data.status === 'paused') return { ok: false, reason: 'RUN_PAUSED' };
    data.session_chain.lease = { ...lease, state: 'released' };
    writeState(root, runId, data);
    return { ok: true, reason: 'released' };
  });
}

// 멱등키 선예약 CAS — phase∈{idle,acquired}에서만 신규 예약. 이중 트리거를 phase로 봉인 (spec §9.1).
// RUN_PAUSED: paused 상태에서는 예약 금지 — emitHandoff 도 차단 (lease intent='lease' 는 leaseCheck 예외지만
// reserveHandoff 는 leaseCheck 를 거치지 않으므로 여기서 명시 차단).
export function reserveHandoff(root, runId, { trigger, boundaryEvent, now = Date.now(), expect } = {}) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    // v1.6 (spec §2.3-1): terminal run에는 새 handoff 예약 금지 — RUN_PAUSED 명시 차단과 대칭.
    if (data.status === 'completed' || data.status === 'stopped') {
      return { ok: false, reserved: false, reason: 'RUN_TERMINAL', key: null, childRunId: null };
    }
    if (data.status === 'paused') {
      return { ok: false, reserved: false, reason: 'RUN_PAUSED', key: null, childRunId: null };
    }
    const lease = data.session_chain.lease;
    if (expect && (lease.owner_run_id !== expect.owner || lease.generation !== expect.generation)) {
      return { ok: false, reserved: false, reason: 'fenced', key: lease.handoff_idempotency_key, childRunId: lease.handoff_child_run_id };
    }
    const boundaryPolicy = data.autonomy?.continuation_policy === 'workstream-session';
    const boundaryError = boundaryPolicy ? boundaryReservationError(data, boundaryEvent, now) : null;
    if (boundaryError) {
      return { ok: false, reserved: false, reason: boundaryError, key: null, childRunId: null };
    }
    const rootDigest = projectRootDigest(data.project?.root);
    const key = boundaryPolicy
      ? contentHash(JSON.stringify([
        'deep-loop-boundary-handoff-v1',
        lease.owner_run_id,
        lease.generation,
        data.project?.binding_generation,
        rootDigest,
        boundaryEvent.seq,
        boundaryEvent.checksum,
      ]))
      : deriveIdempotencyKey(lease.owner_run_id, lease.generation, trigger);
    if (lease.handoff_phase === 'idle' || lease.handoff_phase === 'acquired') {
      // Codex r3 🔴1: childRunId 를 **예약 시점에 결정·영속**한다. 동시/재진입 emit 이 같은 child 를 보게 되어
      // (reserved:false fall-through 가 fresh child 를 만들지 않음) 중복 child 를 봉인한다.
      const childRunId = ulid(now);
      data.session_chain.lease = {
        ...lease, handoff_phase: 'reserved', handoff_idempotency_key: key,
        handoff_child_run_id: childRunId, handoff_trigger: trigger,
        ...(boundaryPolicy ? {
          handoff_boundary_event: { ...boundaryEvent },
          handoff_project_binding_generation: data.project.binding_generation,
          handoff_project_root_digest: rootDigest,
        } : {}),
      };
      writeState(root, runId, data);
      return { ok: true, reserved: true, key, childRunId, reason: 'reserved' };
    }
    if (lease.handoff_idempotency_key === key) {
      if (boundaryPolicy
        && (!sameBoundaryEvent(lease.handoff_boundary_event, boundaryEvent)
          || lease.handoff_project_binding_generation !== data.project.binding_generation
          || lease.handoff_project_root_digest !== rootDigest)) {
        return { ok: false, reserved: false, key, childRunId: lease.handoff_child_run_id, reason: 'BOUNDARY_EVENT_MISMATCH' };
      }
      return { ok: true, reserved: false, key, childRunId: lease.handoff_child_run_id, reason: 'already-reserved-same-trigger' };
    }
    return { ok: false, reserved: false, key: lease.handoff_idempotency_key, childRunId: lease.handoff_child_run_id, reason: 'handoff-in-flight' };
  });
}

export function advanceHandoffPhase(root, runId, { key, toPhase, now = Date.now(), expect } = {}) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    // v1.6 (spec §2.3-3): terminal run의 handoff 전진 금지 — reserve↔advance 사이 finish 경합 및
    // 구버전 오염 상태(terminal+emitted 등)에 대한 방어-심층. respawn은 이 reason을 outcome:'terminal'로 전파.
    if (data.status === 'completed' || data.status === 'stopped') return { ok: false, reason: 'RUN_TERMINAL' };
    const lease = data.session_chain.lease;
    if (expect && (lease.owner_run_id !== expect.owner || lease.generation !== expect.generation)) {
      return { ok: false, reason: 'fenced' };
    }
    if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };
    const topologyError = boundaryHandoffTopologyError(data);
    if (topologyError) return { ok: false, reason: topologyError };
    const cur = PHASE_ORDER[lease.handoff_phase];
    const next = PHASE_ORDER[toPhase];
    if (next === undefined) return { ok: false, reason: `unknown-phase ${toPhase}` };
    if (next === cur) return { ok: true, reason: 'idempotent-noop' };
    if (next !== cur + 1) return { ok: false, reason: `illegal-transition ${lease.handoff_phase}->${toPhase}` };
    const patch = { handoff_phase: toPhase };
    if (toPhase === 'emitted') {
      // 부모 carve-out 시작 + stale TTL 설정. 부모가 emitted 후 죽어 releaseLease 를 못 해도
      // expires_at 경과 시 자식이 인수 가능 (Codex r1 🔴4: null expires_at 은 영원히 안 만료 → 데드락).
      patch.state = 'releasing';
      const ttlMs = (data.session_chain.stale_lease_ttl_sec || 900) * 1000;
      patch.expires_at = new Date(now + ttlMs).toISOString();
    }
    data.session_chain.lease = { ...lease, ...patch };
    writeState(root, runId, data);
    return { ok: true, reason: 'advanced' };
  });
}

export function rollbackHandoff(root, runId, { owner, generation }) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    const lease = data.session_chain.lease;
    if (lease.owner_run_id !== owner || lease.generation !== generation) return { ok: false, reason: 'fenced' };
    const terminal = data.status === 'completed' || data.status === 'stopped';
    // terminal + 잔여 없음(idle, key/child null) → write 없는 no-op (plan r2 P1: 정상-finish 후
    // emitHandoff 거부 경로의 무조건 보상 호출이 idle lease를 다시 쓰지 않도록).
    if (terminal && lease.handoff_phase === 'idle' && !lease.handoff_idempotency_key
      && !lease.handoff_child_run_id && !lease.handoff_trigger) {
      return { ok: true, reason: 'noop-idle-terminal' };
    }
    // active 복귀 시 expires_at=null — 롤백된 부모가 emit 때 설정된 stale TTL 로 나중에 인수당하지 않게 (Codex r2 🔴2)
    data.session_chain.lease = terminal
      // v1.6 terminal-aware (spec §2.3, 3차 r1): active 복원은 terminal run을 "소유된 모양"으로 만들어
      // 미래 우회-writer 실수 표면을 넓힌다 — released로 불활성 안착 (재획득은 acquireLease가 차단).
      ? { ...lease, state: 'released', handoff_phase: 'idle', handoff_idempotency_key: null, handoff_child_run_id: null, handoff_trigger: null, expires_at: null, takeover_kind: null }
      : { ...lease, state: 'active', handoff_phase: 'idle', handoff_idempotency_key: null, handoff_child_run_id: null, handoff_trigger: null, expires_at: null, takeover_kind: null };
    delete data.session_chain.lease.handoff_boundary_event;
    delete data.session_chain.lease.handoff_project_binding_generation;
    delete data.session_chain.lease.handoff_project_root_digest;
    writeState(root, runId, data);
    return { ok: true, reason: 'rolled-back' };
  });
}

// Filesystem-publication compensation for emitHandoff. Rollback is allowed only when the lock-held
// check proves ENOENT/ENOTDIR for both deterministic finals: boolean existsSync can mistake lookup
// errors for absence, while an out-of-lock check races a same-key concurrent publication.
export function rollbackReservedEmit(root, runId, { key, childRunId, expect, statFn = statSync }) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    const lease = data.session_chain.lease;
    const childCommitted = data.session_chain.sessions.some(session => session.run_id === childRunId);
    if (childCommitted || lease.handoff_phase !== 'reserved') {
      return { ok: true, idempotent: childCommitted || ['emitted', 'spawned', 'acquired'].includes(lease.handoff_phase) };
    }
    if (!expect || lease.owner_run_id !== expect.owner || lease.generation !== expect.generation) {
      return { ok: false, reason: 'fenced' };
    }
    if (lease.handoff_idempotency_key !== key || lease.handoff_child_run_id !== childRunId) {
      return { ok: false, reason: 'reservation-mismatch' };
    }
    const handoffDir = join(runDir(root, runId), 'handoffs');
    const finals = [
      join(handoffDir, `${childRunId}-next-session.md`),
      join(handoffDir, `${childRunId}-compaction-state.json`),
    ];
    for (const path of finals) {
      try {
        statFn(path);
        return { ok: false, reason: 'finals-present' };
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
        return { ok: false, reason: 'finals-indeterminate' };
      }
    }
    const terminal = data.status === 'completed' || data.status === 'stopped';
    data.session_chain.lease = {
      ...lease,
      state: terminal ? 'released' : 'active',
      handoff_phase: 'idle',
      handoff_idempotency_key: null,
      handoff_child_run_id: null,
      handoff_trigger: null,
      expires_at: null,
      takeover_kind: null,
    };
    delete data.session_chain.lease.handoff_boundary_event;
    delete data.session_chain.lease.handoff_project_binding_generation;
    delete data.session_chain.lease.handoff_project_root_digest;
    writeState(root, runId, data);
    return { ok: true, rolledBack: true };
  });
}
