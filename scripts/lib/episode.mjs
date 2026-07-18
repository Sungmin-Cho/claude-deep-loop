import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { appendAnchored, directMutationOptions, intentField,
  withVerifiedMutationLock } from './integrity.mjs';
import { assertEpisodeTask, episodeRequestMarkdown } from './schema.mjs';
import { slugify } from './slug.mjs';
import { leaseCheck } from './lease.mjs';
import { MUTATION_TURN_FLOOR } from './budget.mjs';

const NON_TERMINAL = ['pending', 'in_progress', 'blocked'];
const RECORDABLE_TERMINAL = ['done', 'approved', 'rejected'];
const TERMINAL = RECORDABLE_TERMINAL;
const ALL_TERMINAL = [...RECORDABLE_TERMINAL, 'abandoned'];

function episodeRequestProjection({ plugin, role, kind, point, task, workstream = null,
  expectedArtifacts = [], targetMaker, reviewerResolution, evidence, contract,
  initialStatus = 'pending', blockReason, creationRequestIdDigest,
  dispatchRequestIdDigest, dispatchRequestDigest, dispatchResponse } = {}) {
  return { plugin, role, kind, point, task, workstream, expectedArtifacts,
    targetMaker: targetMaker ?? null,
    reviewerResolution: reviewerResolution ?? null,
    evidence_digest: intentField('episode-evidence', evidence),
    contract: structuredClone(contract ?? null),
    initialStatus, blockReason: blockReason ?? null,
    creation_request_id_digest: creationRequestIdDigest ?? null,
    dispatch_request_id_digest: dispatchRequestIdDigest ?? null,
    dispatch_request_digest: dispatchRequestDigest ?? null,
    dispatch_response: structuredClone(dispatchResponse ?? null) };
}

export function episodeRequestDigest(input) {
  return intentField('episode-create-request', episodeRequestProjection(input));
}

const EPISODE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function episodeRequestIdDigest(requestId, dispatchRequestIdDigest) {
  if (dispatchRequestIdDigest != null) {
    if (requestId != null) throw new Error('EPISODE_REQUEST_ID_CONFLICT');
    return null;
  }
  if (!EPISODE_REQUEST_ID.test(requestId || '')) {
    throw new Error('EPISODE_REQUEST_ID_REQUIRED');
  }
  return intentField('episode-create-request-id', requestId);
}

function episodeAppend(root, runId, mutation, event, mutate, preCheck, options,
  buildResponse) {
  const execute = context => {
    const snapshot = context.readVerifiedState();
    preCheck(snapshot.data);
    if (context.recovered !== null) {
      options.onRecovered(snapshot.data, context.recovered);
      return buildResponse();
    }
    const existing = options.onExisting(snapshot.data);
    if (existing !== null) return buildResponse();
    context.appendAnchored(event, mutate, preCheck, options);
    return buildResponse();
  };
  if (mutation !== null) return execute(mutation);
  const { callerBinding, intentDigest, fenceError } = options;
  return withVerifiedMutationLock(root, runId,
    { callerBinding, intentDigest, fenceError }, execute);
}

function createEpisode(root, runId, {
  plugin, role, kind, point, task, workstream = null, expectedArtifacts = [], targetMaker,
  reviewerResolution, evidence, contract, initialStatus = 'pending', blockReason,
  fence, operation, mutation = null, requestId, dispatchRequestIdDigest,
  dispatchRequestDigest, dispatchResponse,
} = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) {
    throw new Error(`FENCE_REQUIRED: ${operation}`);
  }
  if (!plugin || typeof plugin !== 'string' || !plugin.length) {
    throw new Error('EPISODE_INPUT_INVALID: plugin');
  }
  if (!role || typeof role !== 'string' || !role.length
      || !['maker', 'checker'].includes(role)) {
    throw new Error('EPISODE_INPUT_INVALID: role');
  }
  if (!['pending', 'blocked'].includes(initialStatus)) {
    throw new Error('EPISODE_INPUT_INVALID: initialStatus');
  }
  if (initialStatus === 'blocked' && role !== 'checker') {
    throw new Error('EPISODE_INPUT_INVALID: only checker episodes may start blocked');
  }
  if (initialStatus === 'blocked'
      && (!blockReason || typeof blockReason !== 'string')) {
    throw new Error('EPISODE_INPUT_INVALID: blockReason');
  }
  if (reviewerResolution !== undefined
      && (role !== 'checker' || reviewerResolution === null
        || typeof reviewerResolution !== 'object' || Array.isArray(reviewerResolution))) {
    throw new Error('EPISODE_INPUT_INVALID: reviewerResolution');
  }
  if (targetMaker !== undefined && targetMaker !== null
      && (typeof targetMaker !== 'string' || targetMaker.length === 0)) {
    throw new Error('EPISODE_INPUT_INVALID: targetMaker');
  }
  assertEpisodeTask(task);
  if (!kind || typeof kind !== 'string' || !kind.length
      || !point || typeof point !== 'string' || !point.length
      || !Array.isArray(expectedArtifacts)
      || !expectedArtifacts.every(item => typeof item === 'string')) {
    throw new Error('EPISODE_INPUT_INVALID');
  }
  for (const item of expectedArtifacts) {
    if (isAbsolute(item) || item.split(/[/\\]/).includes('..')) {
      throw new Error('EPISODE_ARTIFACT_UNSAFE: ' + item);
    }
  }
  const safePlugin = slugify(plugin) || 'plugin';
  const creationRequestIdDigest = episodeRequestIdDigest(
    requestId, dispatchRequestIdDigest);
  const completeRequest = episodeRequestProjection({ plugin, role, kind, point, task,
    workstream, expectedArtifacts, targetMaker, reviewerResolution, evidence, contract,
    initialStatus, blockReason, creationRequestIdDigest,
    dispatchRequestIdDigest, dispatchRequestDigest, dispatchResponse });
  const requestDigest = episodeRequestDigest({ plugin, role, kind, point, task, workstream,
    expectedArtifacts, targetMaker, reviewerResolution, evidence, contract,
    initialStatus, blockReason, creationRequestIdDigest,
    dispatchRequestIdDigest, dispatchRequestDigest, dispatchResponse });
  let id = null;
  let requestMarkdown = null;
  let requestMarkdownDigest = null;
  let initialEpisode = null;
  const recoverExact = (loop, recoveredTransaction = null) => {
    const recoveredEvents = recoveredTransaction?.events?.filter(event =>
      event.type === 'episode-new' && event.data?.creation_contract === 'episode-create-v1'
        && event.data?.request_digest === requestDigest) ?? [];
    if (recoveredTransaction !== null && recoveredEvents.length !== 1) {
      throw new Error('EPISODE_RESPONSE_PROJECTION_CHANGED');
    }
    const matches = recoveredTransaction !== null
      ? loop.episodes.filter(episode => episode.id === recoveredEvents[0].data.episode_id)
      : loop.episodes.filter(episode => dispatchRequestIdDigest != null
        ? episode.dispatch_request_id_digest === dispatchRequestIdDigest
        : episode.creation_request_id_digest === creationRequestIdDigest);
    if (matches.length !== 1) throw new Error('EPISODE_RESPONSE_PROJECTION_CHANGED');
    const [recovered] = matches;
    if (recovered.plugin !== plugin || recovered.role !== role
        || recovered.kind !== kind || recovered.point !== point
        || recovered.task !== task
        || recovered.workstream_id !== workstream
        || JSON.stringify(recovered.expected_artifacts) !== JSON.stringify(expectedArtifacts)
        || (recovered.target_maker ?? null) !== (targetMaker ?? null)
        || JSON.stringify(recovered.reviewer_resolution ?? null)
          !== JSON.stringify(reviewerResolution ?? null)
        || JSON.stringify(recovered.evidence) !== JSON.stringify(evidence)
        || JSON.stringify(recovered.contract) !== JSON.stringify(contract)
        || recovered.creation_initial_status !== initialStatus
        || (recovered.creation_block_reason ?? null) !== (blockReason ?? null)
        || (recovered.creation_request_id_digest ?? null)
          !== (creationRequestIdDigest ?? null)
        || (recovered.dispatch_request_id_digest ?? null)
          !== (dispatchRequestIdDigest ?? null)
        || (recovered.dispatch_request_digest ?? null) !== (dispatchRequestDigest ?? null)
        || JSON.stringify(recovered.dispatch_response ?? null)
          !== JSON.stringify(dispatchResponse ?? null)
        || recovered.creation_contract !== 'episode-create-v1'
        || recovered.creation_request_digest !== requestDigest) {
      throw new Error(dispatchRequestIdDigest == null
        && recovered.creation_request_id_digest === creationRequestIdDigest
        ? 'EPISODE_REQUEST_CONFLICT' : 'EPISODE_RESPONSE_PROJECTION_CHANGED');
    }
    id = recovered.id;
    requestMarkdown = episodeRequestMarkdown({ id, plugin, role, kind, point, task,
      contract, workstream, expectedArtifacts, evidence });
    requestMarkdownDigest = intentField('episode-request-markdown', requestMarkdown);
    if (recovered.request_path !== undefined
        || recovered.request_markdown !== requestMarkdown
        || recovered.request_markdown_digest !== requestMarkdownDigest) {
      throw new Error('EPISODE_RESPONSE_PROJECTION_CHANGED');
    }
    return recovered;
  };
  const onExisting = loop => loop.episodes.some(episode => dispatchRequestIdDigest != null
    ? episode.dispatch_request_id_digest === dispatchRequestIdDigest
    : episode.creation_request_id_digest === creationRequestIdDigest)
    ? recoverExact(loop) : null;
  const event = { type: 'episode-new', data: {
    plugin, role, kind, point, creation_contract: 'episode-create-v1',
    task, contract: structuredClone(contract ?? null),
    request_digest: requestDigest,
    creation_request_id_digest: creationRequestIdDigest,
    dispatch_request_id_digest: dispatchRequestIdDigest ?? null,
    dispatch_request_digest: dispatchRequestDigest ?? null,
    request_projection: completeRequest,
    ...(initialStatus === 'blocked'
      ? { status: initialStatus, block_reason: blockReason } : {}),
    ...(reviewerResolution ? { reviewer_resolution: reviewerResolution } : {}),
  } };
  const preCheck = loop => {
    const checked = leaseCheck(loop, fence);
    if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
    if (workstream && !loop.workstreams.find(item => item.id === workstream)) {
      throw new Error(`WORKSTREAM_NOT_FOUND: ${workstream}`);
    }
    if (id !== null) return;
    const n = String(loop.episodes.length + 1).padStart(3, '0');
    id = `${n}-${safePlugin}`;
    requestMarkdown = episodeRequestMarkdown({ id, plugin, role, kind, point, task,
      contract, workstream, expectedArtifacts, evidence });
    requestMarkdownDigest = intentField('episode-request-markdown', requestMarkdown);
    event.data.episode_id = id;
    event.data.request_markdown = requestMarkdown;
    event.data.request_markdown_digest = requestMarkdownDigest;
    initialEpisode = {
      id, plugin, role, kind, point, task, workstream_id: workstream, status: initialStatus,
      request_markdown: requestMarkdown,
      request_markdown_digest: requestMarkdownDigest,
      expected_artifacts: structuredClone(expectedArtifacts),
      creation_request_digest: requestDigest, creation_initial_status: initialStatus,
      creation_block_reason: blockReason ?? null, creation_contract: 'episode-create-v1',
      creation_request_id_digest: creationRequestIdDigest,
      dispatch_request_id_digest: dispatchRequestIdDigest ?? null,
      dispatch_request_digest: dispatchRequestDigest ?? null,
      dispatch_response: structuredClone(dispatchResponse ?? null),
      verification: { checker_episode_required: role === 'maker',
        checker_plugin: 'deep-review', review_point: point,
        proof_required: structuredClone(expectedArtifacts) },
      ...(targetMaker ? { target_maker: targetMaker } : {}),
      ...(role === 'checker' ? { requires_independent_session: true } : {}),
      ...(reviewerResolution ? { reviewer_resolution: reviewerResolution } : {}),
      ...(evidence !== undefined ? { evidence: structuredClone(evidence) } : {}),
      ...(contract !== undefined ? { contract: structuredClone(contract) } : {}),
      ...(initialStatus === 'blocked'
        ? { block_reason: blockReason, needs_human: true } : {}),
    };
  };
  const buildResponse = () => Object.freeze({ id,
    requestMarkdown, requestMarkdownDigest });
  const options = mutation !== null
    ? { floor: MUTATION_TURN_FLOOR, onRecovered: recoverExact, onExisting }
    : directMutationOptions(operation, fence, completeRequest,
      `LEASE_FENCED: ${operation}`,
      { floor: MUTATION_TURN_FLOOR, onRecovered: recoverExact, onExisting });
  return episodeAppend(root, runId, mutation, event, loop => {
    const episode = structuredClone(initialEpisode);
    loop.episodes.push(episode);
    loop.current_episode = id;
    if (role === 'maker') {
      loop.comprehension.episodes_total =
        (loop.comprehension.episodes_total || 0) + 1;
    }
    if (workstream) loop.workstreams.find(item => item.id === workstream).episodes.push(id);
  }, preCheck, options, buildResponse);
}

export function newEpisode(root, runId, {
  plugin, role, kind, point, task, workstream = null, expectedArtifacts = [], targetMaker,
  reviewerResolution, evidence, contract, fence, mutation = null, requestId,
  dispatchRequestIdDigest, dispatchRequestDigest, dispatchResponse,
} = {}) {
  return createEpisode(root, runId, { plugin, role, kind, point, task, workstream,
    expectedArtifacts, targetMaker, reviewerResolution, evidence, contract, fence,
    mutation, requestId, dispatchRequestIdDigest, dispatchRequestDigest,
    dispatchResponse, operation: 'newEpisode' });
}

export function newBlockedCheckerEpisode(root, runId, {
  plugin, kind, point, task, workstream = null, targetMaker, reason, reviewerResolution,
  evidence, contract,
  fence, mutation = null, requestId, dispatchRequestIdDigest, dispatchRequestDigest,
  dispatchResponse,
} = {}) {
  return createEpisode(root, runId, { plugin, role: 'checker', kind, point, task, workstream,
    targetMaker, reviewerResolution, evidence, contract,
    initialStatus: 'blocked', blockReason: reason,
    fence, mutation, requestId, dispatchRequestIdDigest, dispatchRequestDigest,
    dispatchResponse, operation: 'newBlockedCheckerEpisode' });
}
// Human-gated escape hatch — settles a stranded non-terminal episode as abandoned.
// Separate from the record path to preserve the done-needs-proof invariant.
export function abandonEpisode(root, runId, episodeId, { reason, confirm, fence } = {}) {
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: pass --confirm (human-only)');
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: abandonEpisode');
  if (!episodeId || typeof episodeId !== 'string' || !episodeId.length) throw new Error('EPISODE_INPUT_INVALID: episodeId');
  if (!reason || typeof reason !== 'string' || !reason.length) throw new Error('EPISODE_INPUT_INVALID: reason');
  appendAnchored(root, runId, { type: 'episode-abandon', data: { id: episodeId, reason } }, (loop) => {
    const ep = loop.episodes.find(e => e.id === episodeId);
    ep.status = 'abandoned';
    ep.abandon_reason = reason;
    if (ep.role === 'maker') {
      const c = loop.comprehension || (loop.comprehension = {});
      c.episodes_total = Math.max(0, (c.episodes_total || 0) - 1);
      if (ep.human_reviewed) c.episodes_human_reviewed = Math.max(0, (c.episodes_human_reviewed || 0) - 1);
      if (ep.agent_reviewed) c.episodes_agent_reviewed = Math.max(0, (c.episodes_agent_reviewed || 0) - 1);
    }
    // P2-a: AFTER the decrement (which read the OLD human_reviewed), mark the abandoned episode reviewed so a later
    // `ack`/`recordReviewed` is a no-op — an abandoned maker is out of episodes_total and must never be re-counted
    // into episodes_human_reviewed (which would make reviewed/total exceed 1 and wrongly drop comprehension debt to 0).
    ep.human_reviewed = true;
  }, (loop) => {
    const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
    const ep = loop.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
    if (ALL_TERMINAL.includes(ep.status)) throw new Error('EPISODE_ALREADY_TERMINAL: ' + episodeId);
  }, directMutationOptions('episode-abandon', fence,
    { episodeId, reason, confirm }, 'LEASE_FENCED: abandonEpisode', {
      floor: MUTATION_TURN_FLOOR, onRecovered: loop => {
        const episode = loop.episodes.find(item => item.id === episodeId);
        if (episode?.status !== 'abandoned' || episode.abandon_reason !== reason) {
          throw new Error('EPISODE_RESPONSE_PROJECTION_CHANGED');
        }
      },
    }));
}

export function recordEpisode(root, runId, episodeId, { status, artifacts = [], proof = {}, fence } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: recordEpisode');
  // Fix 3: episodeId must be a non-empty string
  if (!episodeId || typeof episodeId !== 'string' || !episodeId.length) throw new Error('EPISODE_INPUT_INVALID: episodeId');
  // Cheap input validation BEFORE appendAnchored (no state access needed). Codex impl r7 🔴:
  // a null/non-array `artifacts` or null/non-object `proof` would otherwise throw INSIDE the mutate
  // (after the event is appended), staling event_log_head → BUDGET_TAMPERED on next reconcile.
  if (![...NON_TERMINAL, ...TERMINAL].includes(status)) throw new Error(`EPISODE_STATUS_INVALID: ${status}`);
  if (!Array.isArray(artifacts) || !artifacts.every(a => typeof a === 'string')) throw new Error('EPISODE_INPUT_INVALID: artifacts must be an array of strings');
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) throw new Error('EPISODE_INPUT_INVALID: proof must be an object');
  const proofDigest = intentField('episode-record-proof', proof);
  appendAnchored(root, runId, { type: 'episode-record', data: { id: episodeId, status, artifacts } }, (loop) => {
    const ep = loop.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);   // 방어적
    ep.status = status;
    if (artifacts.length) ep.artifacts = artifacts;
    for (const [k, v] of Object.entries(proof)) if (/^result_[A-Za-z0-9_]+$/.test(k)) ep[k] = v;
  }, (loop) => {
    // Codex r3 🔴: All throwing validations inside preCheck (run on fresh loop, before append)
    if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    const ep = loop.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
    // Codex r3 🔴2 + R1 f2/R2 f1: 현재 status 가 터미널(abandoned 포함)이면 요청 status 무관하게 재기록 불가.
    if (ALL_TERMINAL.includes(ep.status)) {
      throw new Error('EPISODE_ALREADY_TERMINAL: ' + episodeId);
    }
    // 터미널은 커널이 proof에서 파생 — 검증 후에만 (spec §4)
    if (TERMINAL.includes(status)) {
      if (status === 'done') {
        const expected = (ep.expected_artifacts || []);
        // Codex r3 🟡: validate submitted artifacts paths BEFORE coverage check (FIX 4)
        const rootResolved = resolve(root);
        for (const a of artifacts) {
          if (isAbsolute(a) || a.split(/[/\\]/).includes('..')) throw new Error('EPISODE_ARTIFACT_ESCAPE: ' + a);
          const full = resolve(root, a);
          if (!full.startsWith(rootResolved + sep)) throw new Error('EPISODE_ARTIFACT_ESCAPE: ' + a);
        }
        // Codex r2 🟡: 각 expected artifact 경로 안전성 재검증 + root 내 포함 확인.
        for (const a of expected) {
          if (isAbsolute(a) || a.split(/[/\\]/).includes('..')) throw new Error('EPISODE_ARTIFACT_ESCAPE: ' + a);
          const full = resolve(root, a);
          if (!full.startsWith(rootResolved + sep)) throw new Error('EPISODE_ARTIFACT_ESCAPE: ' + a);
        }
        const missing = expected.filter(a => !existsSync(join(root, a)));
        if (expected.length === 0 || missing.length) {
          throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} done requires existing artifacts (missing: ${missing.join(',') || 'none-declared'})`);
        }
        // Codex r2 🟡: 제출된 artifacts 가 expected_artifacts 를 모두 커버하는지 확인.
        const submitted = new Set(artifacts);
        const uncovered = expected.filter(a => !submitted.has(a));
        if (uncovered.length) throw new Error('EPISODE_ARTIFACTS_INCOMPLETE: ' + uncovered.join(','));
      } else if (status === 'approved' && !['APPROVE', 'CONCERN'].includes(proof.verdict)) {
        throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} approved requires proof.verdict=APPROVE|CONCERN (accepted concern)`);
      } else if (status === 'rejected' && proof.verdict !== 'REQUEST_CHANGES') {
        throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} rejected requires proof.verdict=REQUEST_CHANGES`);
      }
    }
  }, directMutationOptions('episode-record', fence,
    { episodeId, status, artifacts, proofDigest }, 'LEASE_FENCED: recordEpisode', {
      floor: MUTATION_TURN_FLOOR, onRecovered: loop => {
        const episode = loop.episodes.find(item => item.id === episodeId);
        if (episode?.status !== status
            || JSON.stringify(episode.artifacts ?? []) !== JSON.stringify(artifacts)) {
          throw new Error('EPISODE_RESPONSE_PROJECTION_CHANGED');
        }
      },
    }));
}
