import { statSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash, ulid } from './envelope.mjs';
import { runtimeFence } from './runtime.mjs';
import { runDir, writeState, withReconciledMutationLock } from './state.mjs';
import { nextAction } from './next-action.mjs';
import { projectRootDigest } from './project-root.mjs';
import { recoveryReservationKind } from './budget.mjs';
import {
  ACQUIRE_HALT,
  acquireHalt,
  buildAcquisitionReceipt,
  clearRecoveryLease,
  consumedFromReceipt,
  contractFields,
  recoverySafetyReason,
  validateBoundaryRecoveryArtifactLocked,
} from './recover.mjs';
import { appendAnchored } from './integrity.mjs';

const PHASE_ORDER = { idle: 0, reserved: 1, emitted: 2, spawned: 3, acquired: 4 };
const RECOVERY_TAKEOVER_KINDS = new Set(['affinity-supersession', 'boundary-recovery']);

function lockedTime(now, clock, context) {
  const value = now === undefined
    ? (typeof clock === 'function' ? clock() : Number.NaN)
    : now;
  const timestamp = new Date(value).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`INVALID_NOW: ${context}`);
  }
  return timestamp;
}

function lockedSafetyTime(clock, context) {
  return lockedTime(undefined, clock, context);
}

function classifiedAcquireFailure(generation, reason, kernelExitCode) {
  const result = { ok: false, generation, reason };
  Object.defineProperty(result, 'kernel_exit_code', {
    value: kernelExitCode,
    enumerable: false,
  });
  return result;
}

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

// §3.6.2 replay 판정 — 조건 1(같은-owner active)은 호출부 분기가 이미 만족시킨다.
// 나머지 여섯 조건이 **전부** 참일 때만 replay이며, 응답은 durable 영수증에서 필드 복사로 복원된다.
function replayedAcquisition(data, { expectGeneration, attempt }) {
  if (data.status !== 'running') return null;                              // 조건 2 (preserve-pause 취소)
  if (typeof attempt !== 'string' || attempt.length === 0) return null;    // 조건 3
  const lease = data.session_chain.lease;
  const receipt = lease.acquisition_receipt;
  if (!receipt || typeof receipt !== 'object') return null;                // 조건 4
  if (receipt.attempt_id !== attempt) return null;                         // 조건 5
  if (receipt.to_generation !== lease.generation) return null;             // 조건 6
  if (receipt.from_generation !== expectGeneration) return null;           // 조건 7
  return contractFields(
    { ok: true, generation: lease.generation, reason: 'acquired' },
    { consumed: consumedFromReceipt(receipt), replayed: true },
  );
}

// Runtime-fenced CAS 인수: released 또는 stale(expired)만, generation === expectGeneration. 성공 시 generation+1.
// spec §3.2: 성공 경로는 `integrity.appendAnchored` 단일 anchored 트랜잭션이다. 이 함수는 더 이상
// `withReconciledMutationLock`을 잡지 않는다 — `appendAnchored`가 유일한 최상위 lock 획득이며 둘을 겹치면
// 불변식 #7(비재진입)을 위반한다(노트 4). §2.1의 검증 1~8은 `preCheck`, 상태 변경은 `mutate`로 옮겼고
// 비진행은 `ACQUIRE_HALT` sentinel throw 로 기존 반환 객체를 그대로 복원한다(노트 1). `opts.floor`는
// 넘기지 않는다 — acquire 는 소유권이 바뀌는 전이라 floor 가 물러나는 세션에 청구된다(노트 5).
export function acquireLease(root, runId, {
  owner,
  expectGeneration,
  runtime,
  now,
  clock = Date.now,
  attemptId = null,
  // 라이브러리 테스트 전용 ingress (spec §3.2 노트 7·8, §11-12). CLI 는 어느 쪽도 노출하지 않는다.
  __testPreCheckSeam,
  __testFaultAt,
}) {
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('INVALID_OWNER');
  const attempt = attemptId ?? null;
  let plan = null;      // preCheck 이 세우고 mutate 가 집행한다 — 같은 lock, 같은 fresh loop
  let outcome = null;   // 진행 성공 응답 — mutate 가 채운다
  const appendOptions = {};
  if (__testPreCheckSeam) appendOptions.preCheckSeam = __testPreCheckSeam;
  if (__testFaultAt) appendOptions.faultAt = __testFaultAt;

  const preCheck = (data, ctx) => {
    const runtimeResult = runtimeFence(data, runtime);
    // runtimeFence 가 만든 객체를 그대로 복원한다 — `generation`도 `kernel_exit_code`도 없는 유일한 형태다.
    if (!runtimeResult.ok) throw acquireHalt(contractFields(runtimeResult));
    const lease = data.session_chain.lease;
    // 같은 owner 가 이미 active 면 멱등 (active 는 만료 deadline 이 없다 — Codex r2 🔴2)
    if (lease.owner_run_id === owner && lease.state === 'active') {
      // v1.6 (spec §2.3-6, r5 P2-b): terminal+active(정상 finish 상태)에서 멱등 성공(already-owned)으로
      // 위장 금지 — resume이 소유권 경계에서 명확히 거부되어야 한다.
      if (data.status === 'stopped' || data.status === 'completed') {
        throw acquireHalt(contractFields({ ok: false, generation: lease.generation, reason: 'run-terminal' }));
      }
      // §3.6.2: terminal 거부 **뒤**, `already-owned` **앞**. 순서가 뒤바뀌면 완료된 run 이 재개되거나
      // replay 에 도달할 수 없다. replay 는 무변이이므로 sentinel 이 성공 객체를 복원한다(§3.6.2).
      const replay = replayedAcquisition(data, { expectGeneration, attempt });
      if (replay) throw acquireHalt(replay);
      throw acquireHalt(contractFields({ ok: true, generation: lease.generation, reason: 'already-owned' }));
    }
    if (lease.generation !== expectGeneration) {
      throw acquireHalt(contractFields(lease.takeover_kind === 'boundary-recovery'
        ? classifiedAcquireFailure(lease.generation, 'generation-mismatch', 3)
        : { ok: false, generation: lease.generation, reason: 'generation-mismatch' }));
    }
    // v1.6 (spec §2.3-6): generation CAS 직후·takeable 체크 앞 — stale expectGeneration은 위에서
    // generation-mismatch(fence-first), generation이 맞는 terminal acquire는 여기서 안정적으로 run-terminal
    // (기존 위치는 takeable 뒤라 terminal+released가 lease-not-takeable/child-not-reserved로 새었다).
    // A recovered run is 'paused' (not terminal) so it remains acquireable.
    if (data.status === 'stopped' || data.status === 'completed') {
      throw acquireHalt(contractFields({ ok: false, generation: lease.generation, reason: 'run-terminal' }));
    }
    const recoveryChild = data.session_chain.sessions.find(
      session => session.run_id === lease.handoff_child_run_id,
    );
    if (lease.takeover_kind === 'affinity-supersession'
      || recoveryChild?.recovery_kind === 'affinity-supersession') {
      throw acquireHalt(contractFields({
        ok: false,
        generation: lease.generation,
        reason: 'RECOVERY_ACQUIRE_REQUIRED',
      }));
    }
    if (lease.takeover_kind === 'boundary-recovery') {
      if (owner !== lease.handoff_child_run_id) {
        throw acquireHalt(contractFields(classifiedAcquireFailure(lease.generation, 'child-not-reserved', 3)));
      }
      if (recoveryReservationKind(data) !== 'boundary-recovery') {
        throw acquireHalt(contractFields(classifiedAcquireFailure(lease.generation, 'recovery-topology-invalid', 1)));
      }
      const child = data.session_chain.sessions.find(session => session.run_id === owner);
      if (!child
        || child.recovery_project_binding_generation !== data.project?.binding_generation
        || child.recovery_project_root_digest !== projectRootDigest(data.project?.root)
        || lease.recovery_rel !== child.recovery_rel
        || lease.recovery_sha256 !== child.recovery_sha256) {
        throw acquireHalt(contractFields(classifiedAcquireFailure(lease.generation, 'recovery-topology-invalid', 1)));
      }
      try {
        // ctx.guard — preCheck 은 이미 lock 을 보유하므로 `…Locked` 계약대로 lock 안에서 읽는다(§3.2 노트 6).
        validateBoundaryRecoveryArtifactLocked(root, runId, data, child, ctx?.guard);
      } catch (capsuleError) {
        // 이 catch 는 capsule 검증 전용이다. sentinel 은 절대 삼키지 않는다.
        if (capsuleError?.message === ACQUIRE_HALT) throw capsuleError;
        throw acquireHalt(contractFields(classifiedAcquireFailure(lease.generation, 'recovery-capsule-invalid', 1)));
      }
      const safetyNow = lockedSafetyTime(clock, 'boundary recovery acquire safety');
      const lockedNow = lockedTime(now, () => safetyNow, 'boundary recovery acquire');
      const safety = recoverySafetyReason(data, safetyNow);
      if (safety) {
        throw acquireHalt(contractFields({
          ok: false,
          generation: lease.generation,
          reason: safety,
          preserved: true,
        }));
      }
      plan = { kind: 'boundary-recovery', iso: new Date(lockedNow).toISOString() };
      return;
    }
    const topologyError = boundaryHandoffTopologyError(data);
    if (topologyError) {
      throw acquireHalt(contractFields({ ok: false, generation: lease.generation, reason: topologyError }));
    }
    // A boundary handoff is a durable one-child reservation, not a stale-lease
    // takeover invitation. TTL expiry is handled by the explicit recovery path;
    // it must never broaden this acquisition authority to an unrelated owner.
    if (lease.takeover_kind === 'boundary-handoff'
      && owner !== lease.handoff_child_run_id) {
      throw acquireHalt(contractFields({ ok: false, generation: lease.generation, reason: 'child-not-reserved' }));
    }
    // takeover 가능: released(정상 인수), releasing+expired(부모 크래시 복구), releasing+예약된child(handshake). active 절대 탈취 안 됨.
    const lockedNow = lockedTime(now, clock, 'lease acquire');
    const expired = lease.expires_at && lockedNow > Date.parse(lease.expires_at);
    const takeable = lease.state === 'released' || (lease.state === 'releasing' && expired) || (lease.state === 'releasing' && owner === lease.handoff_child_run_id);
    if (!takeable) {
      throw acquireHalt(contractFields({ ok: false, generation: lease.generation, reason: 'lease-not-takeable' }));
    }
    // Legacy handoffs reserved a specific child while the reservation was live.
    // Boundary handoffs were fenced above regardless of TTL.
    if (lease.state === 'released' && lease.handoff_child_run_id && owner !== lease.handoff_child_run_id && !expired) {
      throw acquireHalt(contractFields({ ok: false, generation: lease.generation, reason: 'child-not-reserved' }));
    }
    plan = { kind: 'takeover', iso: new Date(lockedNow).toISOString() };
  };

  // 소유권 CAS + descriptor 소비 + unpause + 영수증 — 전부 이 트랜잭션 안에서 같은 fresh loop 위에.
  const mutate = (data) => {
    const lease = data.session_chain.lease;   // 소유권 CAS **직전** 값 — 영수증의 원천(§3.1)
    const { iso } = plan;
    if (plan.kind === 'boundary-recovery') {
      const child = data.session_chain.sessions.find(session => session.run_id === owner);
      const receipt = buildAcquisitionReceipt({
        takeoverKind: 'boundary-recovery',
        childRunId: owner,
        supersededOwnerRunId: lease.owner_run_id,
        boundaryEvent: lease.handoff_boundary_event ?? null,
        projectRootDigest: child?.recovery_project_root_digest ?? null,
        projectBindingGeneration: child?.recovery_project_binding_generation ?? null,
        handoffRel: null,   // recovery 는 exact-command 계약이라 capsule rel 을 에코하지 않는다(§3.1)
        reservationKey: lease.recovery_discriminator ?? lease.handoff_idempotency_key ?? null,
        fromGeneration: expectGeneration,
        toGeneration: expectGeneration + 1,
        at: iso,
        attemptId: attempt,
      });
      data.session_chain.lease = clearRecoveryLease(lease, owner, expectGeneration + 1, iso);
      data.session_chain.lease.acquisition_receipt = receipt;
      data.status = 'running';
      data.pause_reason = null;
      child.started_at = iso;
      outcome = contractFields(
        { ok: true, generation: expectGeneration + 1, reason: 'acquired' },
        { consumed: consumedFromReceipt(receipt) },
      );
      return;
    }
    const waspaused = data.status === 'paused';
    // 예약을 소비했는가 — `handoff_child_run_id === owner`(§3.1). 아니면 예약 없는 released 인수다(r5 확대).
    const consumedReservation = lease.handoff_child_run_id === owner;
    const boundaryReservation = consumedReservation && lease.takeover_kind === 'boundary-handoff';
    const childBefore = data.session_chain.sessions.find(session => session.run_id === owner);
    const receipt = buildAcquisitionReceipt({
      takeoverKind: consumedReservation
        ? (boundaryReservation ? 'boundary-handoff' : 'legacy-handoff')
        : 'released-takeover',
      childRunId: owner,
      supersededOwnerRunId: lease.owner_run_id,
      boundaryEvent: boundaryReservation ? (lease.handoff_boundary_event ?? null) : null,
      projectRootDigest: boundaryReservation ? (lease.handoff_project_root_digest ?? null) : null,
      projectBindingGeneration: boundaryReservation
        ? (lease.handoff_project_binding_generation ?? null)
        : null,
      handoffRel: consumedReservation ? (childBefore?.handoff_rel ?? null) : null,
      reservationKey: consumedReservation ? (lease.handoff_idempotency_key ?? null) : null,
      fromGeneration: expectGeneration,
      toGeneration: expectGeneration + 1,
      at: iso,
      attemptId: attempt,
    });
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
      acquisition_receipt: receipt,
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
    outcome = contractFields(
      { ok: true, generation: expectGeneration + 1, reason: 'acquired' },
      { consumed: consumedFromReceipt(receipt) },
    );
  };

  try {
    appendAnchored(root, runId, {
      // 이벤트 data 는 caller-known 4필드로 축소한다 — mutate 이전에 동결되므로 lock-only 값은 담을 수
      // 없고, 소비 상세의 정본은 `acquisition_receipt` 상태 필드다(ARC-1).
      type: 'lease-acquired',
      data: {
        owner,
        from_generation: expectGeneration,
        to_generation: expectGeneration + 1,
        attempt_id: attempt,
      },
      now,
    }, mutate, preCheck, appendOptions);
  } catch (e) {
    if (e?.message !== ACQUIRE_HALT) throw e;   // ← 이 줄이 없으면 fail-stop 과 펜스가 함께 삼켜진다
    return e.payload;
  }
  return outcome;
}

export function releaseLease(root, runId, { owner, generation }) {
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('INVALID_OWNER');
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    const lease = data.session_chain.lease;
    if (lease.owner_run_id !== owner || lease.generation !== generation) return { ok: false, reason: 'fenced' };
    if (RECOVERY_TAKEOVER_KINDS.has(lease.takeover_kind)) {
      return { ok: false, reason: 'RECOVERY_IN_FLIGHT' };
    }
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
    const lease = data.session_chain.lease;
    if (RECOVERY_TAKEOVER_KINDS.has(lease.takeover_kind)) {
      return {
        ok: false,
        reserved: false,
        reason: 'RECOVERY_IN_FLIGHT',
        key: lease.handoff_idempotency_key,
        childRunId: lease.handoff_child_run_id,
      };
    }
    if (data.status === 'paused') {
      return { ok: false, reserved: false, reason: 'RUN_PAUSED', key: null, childRunId: null };
    }
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
    if (RECOVERY_TAKEOVER_KINDS.has(lease.takeover_kind)) {
      return { ok: false, reason: 'RECOVERY_IN_FLIGHT' };
    }
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
    if (RECOVERY_TAKEOVER_KINDS.has(lease.takeover_kind)) {
      return { ok: false, reason: 'RECOVERY_IN_FLIGHT' };
    }
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
    if (RECOVERY_TAKEOVER_KINDS.has(lease.takeover_kind)) {
      return { ok: false, reason: 'RECOVERY_IN_FLIGHT' };
    }
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
