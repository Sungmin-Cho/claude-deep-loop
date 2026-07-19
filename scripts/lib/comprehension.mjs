import { MUTATION_TURN_FLOOR, readLines, withVerifiedMutationLock } from './integrity.mjs';
import { contentHash } from './envelope.mjs';
import { isHeadlessInvocation } from './respawn.mjs';
import { leaseCheck } from './lease.mjs';
import { sessionRuntime } from './runtime.mjs';

function ackIdentityFence(fence) {
  return loop => {
    if (!fence) return;
    const lease = loop.session_chain?.lease;
    if (lease?.owner_run_id !== fence.owner) {
      throw new Error('LEASE_FENCED: owner-mismatch');
    }
    if (lease?.generation !== fence.generation) {
      throw new Error('LEASE_FENCED: generation-mismatch');
    }
  };
}
export function computeDebt(loop) {
  const c = loop.comprehension || {};
  const total = c.episodes_total || 0;
  // Only the HUMAN counter releases the gate. Machine (agent) reviews accrue to episodes_agent_reviewed,
  // which computeDebt deliberately ignores — a machine APPROVE must never lower comprehension debt (#1).
  const reviewed = c.episodes_human_reviewed || 0;
  const debt_ratio = total === 0 ? 0 : 1 - reviewed / total;
  return { debt_ratio, blocked: total > 0 && debt_ratio >= (c.debt_threshold ?? 0.5) };
}

// Acknowledge that an episode's diff has been reviewed. tamper-evident + 절차 금지 + headless fail-closed (design #1):
//   - actor='human' releases the comprehension gate (episodes_human_reviewed++) but requires confirm===true
//     (형제 abandonEpisode/recover/breaker-reset human-only pattern) — enforced HERE in the lib, so a CLI-bypass
//     direct call cannot mint human credit.
//   - actor='agent' (default) accrues to episodes_agent_reviewed only — it never releases the human gate.
//   - a headless invocation asserting actor='human' is fail-closed: a dedicated comprehension-ack-rejected event
//     is appended (counter never incremented) and a non-ok result returned (single flow — always append then non-ok).
// Every outcome is written through appendAnchored so the ack (and its rejection) lands in the tamper-evident
// event-log with full context {actor, headless, attended} — unlike the old withLock+writeState path, which left
// no audit trail. (MUTATION_TURN_FLOOR is wired in Task 3.)
export function ack(root, runId, episodeId, { actor = 'agent', confirm = false, env = process.env, fence } = {}) {
  // lib-authoritative guards — BEFORE any append/counter change (형제 abandonEpisode:78 동형).
  if (!['human', 'agent'].includes(actor)) throw new Error('INVALID_ACTOR: actor must be human|agent');
  if (actor === 'human' && confirm !== true) throw new Error('CONFIRM_REQUIRED: human ack requires confirm (human-only)');
  if (!fence || typeof fence.owner !== 'string'
      || !Number.isSafeInteger(fence.generation)) throw new Error('FENCE_REQUIRED: ack');
  const fenceCheck = ackIdentityFence(fence);
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const intentDigest = contentHash(JSON.stringify({ operation: 'comprehension-ack',
    ...callerBinding, episode_id: episodeId, actor, confirm: confirm === true }));
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'LEASE_FENCED: ack' }, mutation => {
  const runtime = sessionRuntime(mutation.readVerifiedState({ fenceCheck }).data);
  const headless = isHeadlessInvocation(env, runtime);
  const isHuman = actor === 'human';
  if (isHuman && headless) {
    // fail-closed: a headless session cannot self-assert a human review. Append the rejection (never a counter
    // bump) then return non-ok — single flow, sudo-audit-able.
    mutation.appendAnchored(
      { type: 'comprehension-ack-rejected', data: { episodeId, actor, headless, attended: false, reason: 'headless-human-ack-forbidden' } },
      undefined,
      (loop) => {
        if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
        const ep = loop.episodes.find(e => e.id === episodeId);
        if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
        if (ep.role !== 'maker') throw new Error('ACK_NOT_MAKER: only a maker episode can be acked');   // impl-R3 Fix 5
      },
      { floor: MUTATION_TURN_FLOOR, fenceCheck });
    return { ok: false, rejected: true, reason: 'headless-human-ack-forbidden' };
  }
  let out = { ok: true, already: false };
  mutation.appendAnchored(
    { type: 'comprehension-ack', data: { episodeId, actor, headless, attended: !headless } },
    (loop) => {
      const ep = loop.episodes.find(e => e.id === episodeId);
      // P2-a (belt-and-suspenders): an abandoned maker is already out of episodes_total — never count it.
      if (ep.status === 'abandoned') { out = { ok: true, abandoned: true }; return; }
      if (ep.human_reviewed) { out = { ok: true, already: true }; return; }   // human 우선 — 멱등, agent 도 no-op
      if (isHuman) {
        ep.human_reviewed = true;
        loop.comprehension.episodes_human_reviewed = (loop.comprehension.episodes_human_reviewed || 0) + 1;
      } else {
        if (ep.agent_reviewed) { out = { ok: true, already: true }; return; }   // agent 멱등
        ep.agent_reviewed = true;
        loop.comprehension.episodes_agent_reviewed = (loop.comprehension.episodes_agent_reviewed || 0) + 1;
      }
    },
    (loop) => {
      if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
      const ep = loop.episodes.find(e => e.id === episodeId);
      if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);   // Codex r1 sf-5: overcount 차단
      // impl-R3 Fix 5: ack is a MAKER-review signal. episodes_total counts only makers, so acking a checker would
      // inflate episodes_human_reviewed past episodes_total and drive debt_ratio below threshold with no maker reviewed.
      if (ep.role !== 'maker') throw new Error('ACK_NOT_MAKER: only a maker episode can be acked');
    },
    { floor: MUTATION_TURN_FLOOR, fenceCheck });
  return out;
  });
}

const REVIEWED_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function recordReviewed(root, runId, episodeId, source,
  { fence, requestId } = {}) {
  if (typeof fence?.owner !== 'string' || !Number.isSafeInteger(fence?.generation)) {
    throw new Error('FENCE_REQUIRED: recordReviewed');
  }
  if (!REVIEWED_REQUEST_ID.test(requestId || '')) {
    throw new Error('REQUEST_ID_REQUIRED: recordReviewed');
  }
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const requestIdDigest = contentHash(`comprehension-reviewed-id\0${requestId}`);
  const requestDigest = contentHash(JSON.stringify({
    contract: 'comprehension-reviewed-v1', episode_id: episodeId, source,
    request_id_digest: requestIdDigest,
  }));
  const intentDigest = contentHash(JSON.stringify({
    operation: 'comprehension-reviewed', ...callerBinding, request_digest: requestDigest,
  }));
  const fenceCheck = ackIdentityFence(fence);
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'LEASE_FENCED: recordReviewed',
    intentConflictError: 'COMPREHENSION_REQUEST_CONFLICT' }, context => {
    const { data } = context.readVerifiedState({ fenceCheck });
    const authorized = leaseCheck(data, { ...fence, intent: fence.intent ?? 'business' });
    if (!authorized.ok) {
      if (authorized.reason === 'RUN_TERMINAL') {
        throw new Error('RUN_TERMINAL: recordReviewed');
      }
      throw new Error(`LEASE_FENCED: ${authorized.reason}`);
    }
    const matches = readLines(root, runId).filter(event =>
      event.type === 'comprehension-reviewed'
      && event.data?.request_id_digest === requestIdDigest);
    if (matches.length > 1) throw new Error('COMPREHENSION_RECOVERY_PROJECTION_MISMATCH');
    if (matches.length === 1) {
      const [event] = matches;
      if (event.data?.request_digest !== requestDigest
          || event.data?.owner_run_id !== fence.owner
          || event.data?.generation !== fence.generation
          || event.data?.episode_id !== episodeId || event.data?.source !== source
          || event.data?.changed !== true) {
        throw new Error('COMPREHENSION_REQUEST_CONFLICT');
      }
      if (context.recovered !== null
          && !context.recovered.events.some(item => item.seq === event.seq
            && item.checksum === event.checksum)) {
        throw new Error('COMPREHENSION_RECOVERY_PROJECTION_MISMATCH');
      }
      return;
    }
    if (context.recovered !== null) {
      throw new Error('COMPREHENSION_RECOVERY_PROJECTION_MISMATCH');
    }
    if (source === 'deep-review-approve' && data.review?.require_human_ack === true) return;
    const episode = data.episodes.find(item => item.id === episodeId);
    if (!episode || episode.status === 'abandoned' || episode.human_reviewed) return;
    context.appendAnchored({ type: 'comprehension-reviewed', data: {
      owner_run_id: fence.owner, generation: fence.generation,
      episode_id: episodeId, source, changed: true,
      request_id_digest: requestIdDigest, request_digest: requestDigest,
    } }, candidate => {
      const item = candidate.episodes.find(value => value.id === episodeId);
      item.human_reviewed = true;
      candidate.comprehension.episodes_human_reviewed =
        (candidate.comprehension.episodes_human_reviewed || 0) + 1;
    }, undefined, { fenceCheck });
  });
}
