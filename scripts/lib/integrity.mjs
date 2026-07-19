import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync,
  truncateSync } from 'node:fs';
import { basename, join } from 'node:path';
import { contentHash } from './envelope.mjs';
import { runDir, readState, withLock } from './state.mjs';
import { assertProjectRootBinding, canonicalProjectRoot, projectRootDigest } from './project-root.mjs';
import { assertEpisodeTask, episodeProofProjection, episodeRequestMarkdown,
  legacyAuthorityDigest, legacyProofOrigins,
  normalizeLegacyActiveWorkstreams, validate,
  verifyAppEventCorrelation, workstreamProofProjection } from './schema.mjs';
import { initializationRequestDigest } from './init-transaction.mjs';
import { replaceFileDurably, syncParentDirectory, syncRegularFile,
  unlinkRegularFile } from './durable-file.mjs';

const logPath = (root, runId) => join(runDir(root, runId), 'event-log.jsonl');

// #3: every business-intent mutation is charged at least this many turns via appendAnchored's `opts.floor`
// (paired cost, same anchor). Lives here (with the floor mechanism) so both state.mjs and budget.mjs can import
// it without a state↔budget cycle; budget.mjs re-exports it for call sites/tests.
export const MUTATION_TURN_FLOOR = 1;

export function readLines(root, runId) {
  const p = logPath(root, runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function checksumFor(seq, ts, type, data, prev) {
  return contentHash(`${seq}|${ts}|${type}|${JSON.stringify(data)}|${prev}`);
}

function nextEvent(lines, { type, data, now }) {
  const prev = lines.length ? lines[lines.length - 1].checksum : 'GENESIS';
  const seq = lines.length + 1;
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_NOW: event timestamp');
  const ts = date.toISOString();
  const checksum = checksumFor(seq, ts, type, data, prev);
  return { seq, ts, type, data, checksum };
}

export function appendEvent(root, runId, { type, data, now }) {
  const event = nextEvent(readLines(root, runId), { type, data, now });
  appendFileSync(logPath(root, runId), JSON.stringify(event) + '\n');
  return event;
}

// line-based 검증 — 호출자가 이미 읽어둔 in-memory 배열을 검증한다. "검증한 배열 == 분석하는 배열"이
// 필요한 소비자(insights의 단일 읽기 스냅샷)가 디스크 재읽기 없이 쓴다 (impl-R2 🟡2: verifyHead와
// readLines 사이 concurrent append가 검증 밖 suffix로 유입되는 창 제거).
export function verifyLines(lines) {
  const errors = [];
  let prev = 'GENESIS';
  lines.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`seq gap at ${i + 1}`);
    if (e.checksum !== checksumFor(e.seq, e.ts, e.type, e.data, prev)) errors.push(`checksum break at seq ${e.seq}`);
    if (e.type === 'cost' && !validCost(e.data)) errors.push(`invalid cost data at seq ${e.seq}`);
    prev = e.checksum;
  });
  return { ok: errors.length === 0, errors };
}

export function verifyLog(root, runId) {
  return verifyLines(readLines(root, runId));
}

// cost turns/tokens는 유한 비음수만 허용 (음수 주입으로 spent를 낮추는 우회 차단, Codex impl 🔴2)
export function validCost(d) {
  return d && Number.isFinite(d.turns) && d.turns >= 0 && Number.isFinite(d.tokens) && d.tokens >= 0;
}

export function recomputeSpent(root, runId) {
  return spentOfLines(readLines(root, runId));
}

// 마지막 이벤트의 head {seq, checksum} (빈 로그면 GENESIS) — loop.json 앵커와 대조용 (Codex impl 🔴3)
export function headOfLines(lines) {
  return lines.length ? { seq: lines[lines.length - 1].seq, checksum: lines[lines.length - 1].checksum } : { seq: 0, checksum: 'GENESIS' };
}

export function lastLogHead(root, runId) {
  return headOfLines(readLines(root, runId));
}

// 로그 tail이 기대 head와 일치하는지 — suffix truncation 탐지. line-based 변형은 verifyLines와 같은
// 이유(검증 배열과 소비 배열의 동일성)로 존재한다.
export function verifyHeadLines(lines, expected) {
  const exp = expected || { seq: 0, checksum: 'GENESIS' };
  const head = headOfLines(lines);
  if (head.seq !== exp.seq || head.checksum !== exp.checksum) {
    return { ok: false, errors: [`log head ${head.seq}/${head.checksum} != anchor ${exp.seq}/${exp.checksum}`] };
  }
  return { ok: true, errors: [] };
}

export function verifyHead(root, runId, expected) {
  return verifyHeadLines(readLines(root, runId), expected);
}

export function verifyEpisodeCreationCorrelation(loop, lines) {
  const errors = [];
  const allEvents = lines.filter(event => event.type === 'episode-new');
  const allEpisodes = loop?.episodes || [];
  // Task 7B authenticates the existing unversioned creation surface through proof-transition
  // chains. Task 7F owns the richer episode-create-v1 request contract; until the first such
  // record exists, do not pretend the older event contains fields its writer never emitted.
  if (!allEvents.some(event => event.data?.creation_contract != null)
      && !allEpisodes.some(episode => episode.creation_contract != null)) {
    return { ok: true, errors: [] };
  }
  const baselines = lines.filter(event => event.type === 'lease-lineage-baselined');
  let legacyCount = 0;
  let versionedEvents = allEvents;
  if (loop?.initialization == null) {
    if (baselines.length === 0) {
      if (allEvents.some(event => event.data?.creation_contract != null)
          || allEpisodes.some(episode => episode.creation_contract != null)) {
        errors.push('legacy run has versioned episodes without an explicit baseline');
      }
      return { ok: errors.length === 0, errors };
    }
    if (baselines.length !== 1) {
      errors.push('legacy run requires exactly one episode baseline');
      return { ok: false, errors };
    }
    const baselineIndex = lines.indexOf(baselines[0]);
    versionedEvents = lines.slice(baselineIndex + 1)
      .filter(event => event.type === 'episode-new');
    legacyCount = baselines[0].data?.legacy_episode_count;
    const legacyWorkstreamCount = baselines[0].data?.legacy_workstream_count;
    if (!Number.isSafeInteger(legacyCount) || legacyCount < 0
        || legacyCount > allEpisodes.length
        || !Number.isSafeInteger(legacyWorkstreamCount) || legacyWorkstreamCount < 0
        || legacyWorkstreamCount > (loop.workstreams ?? []).length) {
      errors.push('legacy creation baseline mismatch');
      return { ok: false, errors };
    }
  } else if (baselines.length !== 0) {
    errors.push('initialized run cannot declare a legacy episode baseline');
  }
  if (allEpisodes.length !== legacyCount + versionedEvents.length) {
    errors.push('episode object/event cardinality mismatch');
  }
  for (let index = 0; index < legacyCount; index += 1) {
    if (allEpisodes[index]?.creation_contract != null) {
      errors.push(`legacy episode baseline contains versioned entry ${index}`);
    }
  }
  const episodes = allEpisodes.slice(legacyCount);
  const events = versionedEvents;
  for (let index = 0; index < Math.max(episodes.length, events.length); index += 1) {
    if (episodes[index]?.creation_contract !== 'episode-create-v1'
        || events[index]?.data?.creation_contract !== 'episode-create-v1') {
      errors.push(`episode creation contract missing at index ${legacyCount + index}`);
    }
  }
  const eventById = new Map();
  for (const event of events) {
    const id = event.data?.episode_id;
    if (typeof id !== 'string' || eventById.has(id)) {
      errors.push(`duplicate or invalid episode-new identity ${String(id)}`);
    } else eventById.set(id, event);
  }
  const episodeById = new Map();
  const requestIdentityOwners = new Map();
  for (const episode of episodes) {
    if (typeof episode.id !== 'string' || episodeById.has(episode.id)) {
      errors.push(`duplicate or invalid episode object identity ${String(episode.id)}`);
      continue;
    }
    episodeById.set(episode.id, episode);
    const event = eventById.get(episode.id);
    if (!event) { errors.push(`episode ${episode.id} has no creation event`); continue; }
    const projection = {
      plugin: episode.plugin, role: episode.role, kind: episode.kind, point: episode.point,
      task: episode.task,
      workstream: episode.workstream_id ?? null,
      expectedArtifacts: structuredClone(episode.expected_artifacts ?? []),
      targetMaker: episode.target_maker ?? null,
      reviewerResolution: episode.reviewer_resolution ?? null,
      evidence_digest: intentField('episode-evidence', episode.evidence),
      contract: structuredClone(episode.contract ?? null),
      initialStatus: episode.creation_initial_status,
      blockReason: episode.creation_block_reason ?? null,
      creation_request_id_digest: episode.creation_request_id_digest ?? null,
      dispatch_request_id_digest: episode.dispatch_request_id_digest ?? null,
      dispatch_request_digest: episode.dispatch_request_digest ?? null,
      dispatch_response: structuredClone(episode.dispatch_response ?? null),
    };
    const recomputed = intentField('episode-create-request', projection);
    let expectedMarkdown = null;
    try {
      assertEpisodeTask(episode.task);
      expectedMarkdown = episodeRequestMarkdown({ id: episode.id,
        plugin: episode.plugin, role: episode.role, kind: episode.kind, point: episode.point,
        workstream: episode.workstream_id ?? null,
        expectedArtifacts: structuredClone(episode.expected_artifacts ?? []),
        task: episode.task, contract: episode.contract, evidence: episode.evidence });
    } catch { /* the mismatch below is authoritative */ }
    const markdownDigest = expectedMarkdown == null ? null
      : intentField('episode-request-markdown', expectedMarkdown);
    if (recomputed !== episode.creation_request_digest
        || recomputed !== event.data.request_digest
        || JSON.stringify(projection) !== JSON.stringify(event.data.request_projection)
        || (episode.creation_request_id_digest ?? null)
          !== (event.data.creation_request_id_digest ?? null)
        || (episode.dispatch_request_id_digest ?? null)
          !== (event.data.dispatch_request_id_digest ?? null)
        || (episode.dispatch_request_digest ?? null)
          !== (event.data.dispatch_request_digest ?? null)
        || episode.request_path !== undefined
        || episode.request_markdown !== expectedMarkdown
        || episode.request_markdown_digest !== markdownDigest
        || event.data.request_markdown !== expectedMarkdown
        || event.data.request_markdown_digest !== markdownDigest
        || event.data.task !== episode.task
        || JSON.stringify(event.data.contract ?? null)
          !== JSON.stringify(episode.contract ?? null)
        || event.data.episode_id !== episode.id) {
      errors.push(`episode ${episode.id} creation projection mismatch`);
    }
    const hasCallerId = episode.creation_request_id_digest != null;
    const hasDispatchId = episode.dispatch_request_id_digest != null;
    const callerIdValid = hasCallerId
      && /^[0-9a-f]{64}$/.test(episode.creation_request_id_digest);
    const dispatchIdValid = hasDispatchId
      && /^[0-9a-f]{64}$/.test(episode.dispatch_request_id_digest);
    const dispatchRequestValid = hasDispatchId
      ? /^[0-9a-f]{64}$/.test(episode.dispatch_request_digest || '')
      : episode.dispatch_request_digest == null;
    if (hasCallerId === hasDispatchId || hasCallerId !== callerIdValid
        || hasDispatchId !== dispatchIdValid || !dispatchRequestValid) {
      errors.push(`episode ${episode.id} has ambiguous creation identity`);
      continue;
    }
    const requestIdentity = hasCallerId
      ? `caller:${episode.creation_request_id_digest}`
      : `dispatch:${episode.dispatch_request_id_digest}`;
    const priorIdentityOwner = requestIdentityOwners.get(requestIdentity);
    if (priorIdentityOwner !== undefined && priorIdentityOwner !== episode.id) {
      errors.push(`duplicate episode creation request identity ${requestIdentity}`);
    } else {
      requestIdentityOwners.set(requestIdentity, episode.id);
    }
  }
  for (const id of eventById.keys()) {
    if (!episodeById.has(id)) errors.push(`episode-new ${id} has no episode object`);
  }
  return { ok: errors.length === 0, errors };
}

export function verifyWorkstreamCreationCorrelation(loop, lines) {
  const errors = [];
  const allWorkstreams = Array.isArray(loop?.workstreams) ? loop.workstreams : [];
  const allEvents = lines.filter(event => event.type === 'workstream-new');
  // Workstream request correlation is versioned by its later owning card. The Task 7B proof chain
  // still binds every legacy creation event to the exact prospective object digest.
  if (!allEvents.some(event => event.data?.creation_contract != null)
      && !allWorkstreams.some(workstream => workstream.creation_contract != null)) {
    return { ok: true, errors: [] };
  }
  const baselines = lines.filter(event => event.type === 'lease-lineage-baselined');
  let legacyCount = 0;
  let versionedEvents = allEvents;
  if (loop?.initialization == null) {
    if (baselines.length === 0) {
      if (allEvents.some(event => event.data?.creation_contract != null)
          || allWorkstreams.some(workstream => workstream.creation_contract != null)) {
        errors.push('legacy run has versioned workstreams without an explicit baseline');
      }
      return { ok: errors.length === 0, errors };
    }
    if (baselines.length !== 1) {
      return { ok: false, errors: ['legacy run requires exactly one workstream baseline'] };
    }
    const baselineIndex = lines.indexOf(baselines[0]);
    versionedEvents = lines.slice(baselineIndex + 1)
      .filter(event => event.type === 'workstream-new');
    legacyCount = baselines[0].data?.legacy_workstream_count;
  } else if (baselines.length !== 0) {
    errors.push('initialized run cannot declare a legacy workstream baseline');
  }
  if (!Number.isSafeInteger(legacyCount) || legacyCount < 0
      || legacyCount > allWorkstreams.length
      || allWorkstreams.length !== legacyCount + versionedEvents.length) {
    errors.push('workstream object/event cardinality mismatch');
    return { ok: false, errors };
  }
  for (let index = 0; index < legacyCount; index += 1) {
    if (allWorkstreams[index]?.creation_contract != null) {
      errors.push(`legacy workstream baseline contains versioned entry ${index}`);
    }
  }
  const eventById = new Map();
  for (const event of versionedEvents) {
    const id = event.data?.id;
    if (typeof id !== 'string' || eventById.has(id)) {
      errors.push(`duplicate or invalid workstream-new identity ${String(id)}`);
    } else eventById.set(id, event);
  }
  const objectById = new Map();
  const requestIdentityOwners = new Map();
  for (const workstream of allWorkstreams.slice(legacyCount)) {
    if (typeof workstream.id !== 'string' || objectById.has(workstream.id)) {
      errors.push(`duplicate or invalid workstream object identity ${String(workstream.id)}`);
      continue;
    }
    objectById.set(workstream.id, workstream);
    const event = eventById.get(workstream.id);
    const projection = { title: workstream.title, branch: workstream.branch,
      worktree: workstream.worktree, baseCommit: workstream.base_commit,
      dependsOn: structuredClone(workstream.depends_on ?? []) };
    const digest = intentField('workstream-create-request', projection);
    const requestIdentity = workstream.creation_request_id_digest;
    const priorIdentityOwner = requestIdentityOwners.get(requestIdentity);
    if (priorIdentityOwner !== undefined && priorIdentityOwner !== workstream.id) {
      errors.push(`duplicate workstream creation request identity ${requestIdentity}`);
    } else if (/^[0-9a-f]{64}$/.test(requestIdentity || '')) {
      requestIdentityOwners.set(requestIdentity, workstream.id);
    }
    if (!event || workstream.creation_contract !== 'workstream-create-v1'
        || event.data?.creation_contract !== 'workstream-create-v1'
        || workstream.creation_request_digest !== digest
        || event.data?.creation_request_digest !== digest
        || workstream.creation_request_id_digest !== event.data?.creation_request_id_digest
        || !/^[0-9a-f]{64}$/.test(workstream.creation_request_id_digest || '')
        || JSON.stringify(event.data?.request_projection) !== JSON.stringify(projection)) {
      errors.push(`workstream ${workstream.id} creation projection mismatch`);
    }
  }
  for (const id of eventById.keys()) {
    if (!objectById.has(id)) errors.push(`workstream-new ${id} has no workstream object`);
  }
  return { ok: errors.length === 0, errors };
}

export function proofEntityDigest(kind, value, loop = null) {
  const projection = kind === 'episode'
    ? episodeProofProjection(value)
    : kind === 'workstream'
      ? workstreamProofProjection(loop, value)
      : (() => { throw new Error(`PROOF_ENTITY_KIND_INVALID: ${kind}`); })();
  return contentHash(`proof-entity-${kind}-v1\0${JSON.stringify({
    kind: 'object', value: projection,
  })}`);
}

export function proofTransitionsForCandidate(beforeLoop, candidateLoop, entityKeys = null) {
  const inventory = loop => [
    ...(loop?.episodes ?? []).map(item => `episode:${item.id}`),
    ...(loop?.workstreams ?? []).map(item => `workstream:${item.id}`),
  ];
  const keys = [...new Set(entityKeys ?? [...inventory(beforeLoop), ...inventory(candidateLoop)])]
    .sort();
  const entity = (loop, key) => {
    const split = key.indexOf(':');
    const kind = key.slice(0, split); const id = key.slice(split + 1);
    const value = kind === 'episode'
      ? (loop?.episodes ?? []).find(item => item.id === id)
      : kind === 'workstream'
        ? (loop?.workstreams ?? []).find(item => item.id === id)
        : null;
    return { kind, id, value };
  };
  return keys.flatMap(key => {
    const before = entity(beforeLoop, key); const after = entity(candidateLoop, key);
    if (after.value == null) throw new Error(`PROOF_ENTITY_REMOVAL_FORBIDDEN: ${key}`);
    const beforeDigest = before.value == null ? 'NONE'
      : proofEntityDigest(before.kind, before.value, beforeLoop);
    const afterDigest = proofEntityDigest(after.kind, after.value, candidateLoop);
    if (entityKeys == null && beforeDigest === afterDigest) return [];
    return [{ kind: after.kind, id: after.id,
      before_digest: beforeDigest, after_digest: afterDigest }];
  });
}

function validateProofTransitionEventShape(event, transitions) {
  const errors = [];
  const actual = transitions.map(item => `${item?.kind}:${item?.id}`);
  const sorted = [...actual].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sorted)
      || new Set(actual).size !== actual.length) {
    errors.push('proof transitions are not unique canonical order');
  }
  let expected;
  if (event.type === 'episode-new') {
    expected = typeof event.data?.episode_id === 'string'
      ? [`episode:${event.data.episode_id}`] : actual;
    if (actual.length === 0 || actual.some(key => !key.startsWith('episode:'))) {
      errors.push('episode creation transition entity set mismatch');
    }
  }
  else if (event.type === 'episode-record' || event.type === 'episode-abandon') {
    expected = [`episode:${event.data?.id}`];
  } else if (event.type === 'independent-review-claimed'
      || event.type === 'independent-review-blocked') {
    expected = [`episode:${event.data?.episode_id}`];
  } else if (event.type === 'review-outcome') {
    expected = [`episode:${event.data?.episodeId}`,
      `workstream:${event.data?.workstream_id}`].sort();
  } else if (event.type === 'workstream-new') {
    const eventKey = typeof event.data?.id === 'string'
      ? `workstream:${event.data.id}` : null;
    if ((eventKey !== null && !actual.includes(eventKey))
        || actual.length === 0 || actual.some(key => !key.startsWith('workstream:'))) {
      errors.push('workstream creation transition entity set mismatch');
    }
    return errors;
  } else if (event.type === 'workstream-status' || event.type === 'workstream-terminal') {
    if (!actual.includes(`workstream:${event.data?.id}`)
        || actual.some(key => !key.startsWith('workstream:'))) {
      errors.push('workstream mutation transition entity set mismatch');
    }
    return errors;
  } else if (event.type === 'state-patch') {
    // The redacted state-patch event cannot reproduce removed active membership from current state.
    // Its writer records the canonical set of every projection that actually changed; chain
    // continuity plus the final projection comparison authenticates that set.
    return errors;
  } else return ['unexpected proof transition event'];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push('proof transition entity set mismatch');
  }
  return errors;
}

const PROOF_EVENT_TYPES = new Set([
  'episode-new', 'episode-record', 'episode-abandon',
  'independent-review-claimed', 'independent-review-blocked', 'review-outcome',
  'workstream-new', 'workstream-status', 'workstream-terminal', 'state-patch',
]);

function requiredProofKeys(event, changedKeys) {
  if (event.type === 'episode-new') {
    const explicit = typeof event.data?.episode_id === 'string'
      ? [`episode:${event.data.episode_id}`] : [];
    return [...new Set([...changedKeys, ...explicit])].sort();
  }
  if (event.type === 'episode-record' || event.type === 'episode-abandon') {
    return [`episode:${event.data?.id}`];
  }
  if (event.type === 'independent-review-claimed'
      || event.type === 'independent-review-blocked') {
    return [`episode:${event.data?.episode_id}`];
  }
  if (event.type === 'review-outcome') {
    return [`episode:${event.data?.episodeId}`,
      `workstream:${event.data?.workstream_id}`].sort();
  }
  if (event.type === 'workstream-new') {
    const explicit = typeof event.data?.id === 'string'
      ? [`workstream:${event.data.id}`] : [];
    return [...new Set([...changedKeys, ...explicit])].sort();
  }
  if (event.type === 'workstream-status' || event.type === 'workstream-terminal') {
    return [...new Set([...changedKeys, `workstream:${event.data?.id}`])].sort();
  }
  if (event.type === 'state-patch') return [...changedKeys].sort();
  throw new Error(`PROOF_EVENT_TYPE_INVALID: ${event.type}`);
}

// The gateway calls this only after one business mutator has produced its exact candidate. It is
// the sole writer of proof_transitions: individual public writers never accept callbacks or build
// their own digest arrays. At most one proof-bearing business event is allowed per transaction.
export function attachCandidateProofTransitions(beforeLoop, candidateLoop, eventSpecs) {
  const proofEvents = eventSpecs.filter(event => PROOF_EVENT_TYPES.has(event.type));
  const changed = proofTransitionsForCandidate(beforeLoop, candidateLoop);
  const changedKeys = changed.map(item => `${item.kind}:${item.id}`).sort();
  if (proofEvents.length === 0) {
    if (changedKeys.length !== 0) throw new Error('PROOF_CHANGE_EVENT_REQUIRED');
    return eventSpecs;
  }
  if (proofEvents.length !== 1) throw new Error('PROOF_EVENT_CARDINALITY_INVALID');
  const [event] = proofEvents;
  const keys = requiredProofKeys(event, changedKeys);
  if (changedKeys.some(key => !keys.includes(key))) {
    throw new Error('PROOF_CHANGE_ENTITY_SET_INVALID');
  }
  event.data = { ...structuredClone(event.data),
    proof_transitions: proofTransitionsForCandidate(beforeLoop, candidateLoop, keys) };
  return eventSpecs;
}

// Every post-checkpoint proof-bearing mutation event carries one exact, ordered
// proof_transitions array. A transaction such as review-outcome may change both the checker and its
// workstream; one event therefore carries one four-key entry per affected proof entity. Creation
// uses before_digest='NONE'. Writers compute before from the verified snapshot and after from the
// one candidate installed by the same anchored commit.
export function verifyProofTransitionCorrelation(loop, lines) {
  const errors = [];
  const baseline = lines.find(event => event.type === 'lease-lineage-baselined') ?? null;
  if (loop?.initialization == null && baseline === null) {
    return { ok: true, errors: [] }; // pre-checkpoint legacy history is intentionally opaque
  }
  const floor = baseline === null ? 0 : lines.indexOf(baseline) + 1;
  const chains = new Map();
  if (baseline !== null) {
    for (const origin of (baseline.data?.legacy_proof_origins ?? [])) {
      const key = `${origin.kind}:${origin.id}`;
      if (chains.has(key)) errors.push(`duplicate legacy proof origin for ${key}`);
      else chains.set(key, origin.digest);
    }
  }
  for (const event of lines.slice(floor)) {
    if (!PROOF_EVENT_TYPES.has(event.type)) continue;
    const transitions = event.data?.proof_transitions;
    if (!Array.isArray(transitions)) {
      errors.push(`proof transitions missing at event ${event.seq}`);
      continue;
    }
    const expectedKeys = ['after_digest', 'before_digest', 'id', 'kind'];
    const eventKeys = new Set();
    for (const transition of transitions) {
      if (transition == null
          || JSON.stringify(Object.keys(transition).sort()) !== JSON.stringify(expectedKeys)
          || !['episode', 'workstream'].includes(transition.kind)
          || typeof transition.id !== 'string' || transition.id.length === 0
          || !/^[0-9a-f]{64}$/.test(transition.after_digest || '')
          || !(/^[0-9a-f]{64}$/.test(transition.before_digest || '')
            || transition.before_digest === 'NONE')) {
        errors.push(`proof transition invalid at event ${event.seq}`);
        continue;
      }
      const key = `${transition.kind}:${transition.id}`;
      const expectedBefore = chains.get(key) ?? 'NONE';
      const creation = (event.type === 'episode-new'
          && (typeof event.data?.episode_id === 'string'
            ? key === `episode:${event.data.episode_id}` : expectedBefore === 'NONE'))
        || (event.type === 'workstream-new'
          && (typeof event.data?.id === 'string'
            ? key === `workstream:${event.data.id}` : expectedBefore === 'NONE'));
      if (eventKeys.has(key) || transition.before_digest !== expectedBefore
          || creation !== (expectedBefore === 'NONE')) {
        errors.push(`proof transition disconnected for ${key}`);
        continue;
      }
      eventKeys.add(key);
      chains.set(key, transition.after_digest);
    }
    // validateProofTransitionEventShape checks exact entity identities and cardinality:
    // ordinary entity events carry one entry, review-outcome carries checker+workstream (including
    // an unchanged workstream digest on rejection/idempotent approval), and state-patch carries the
    // sorted set of every episode/workstream projection changed by its candidate.
    errors.push(...validateProofTransitionEventShape(event, transitions)
      .map(error => `${error} at event ${event.seq}`));
  }
  const current = new Map();
  for (const episode of (loop.episodes ?? [])) {
    current.set(`episode:${episode.id}`, proofEntityDigest('episode', episode, loop));
  }
  for (const workstream of (loop.workstreams ?? [])) {
    current.set(`workstream:${workstream.id}`,
      proofEntityDigest('workstream', workstream, loop));
  }
  for (const [key, digest] of current) {
    if (chains.get(key) !== digest) errors.push(`proof state/event mismatch for ${key}`);
  }
  for (const key of chains.keys()) {
    if (!current.has(key)) errors.push(`orphan proof transition for ${key}`);
  }
  return { ok: errors.length === 0, errors };
}

export function verifyRunSnapshot(loop, lines) {
  const errors = [];
  const state = validate(loop);
  if (!state.ok) errors.push(...state.errors.map(error => `schema: ${error}`));
  if (loop?.initialization != null) {
    const actualRequestDigest = initializationRequestDigest(
      loop.initialization.request_projection);
    if (actualRequestDigest !== loop.initialization.request_digest) {
      errors.push('initialization: stored request projection digest mismatch');
    }
  }
  const chain = verifyLines(lines);
  if (!chain.ok) errors.push(...chain.errors.map(error => `event chain: ${error}`));
  const head = verifyHeadLines(lines, loop?.event_log_head);
  if (!head.ok) errors.push(...head.errors.map(error => `event head: ${error}`));
  const app = verifyAppEventCorrelation(loop, lines);
  if (!app.ok) errors.push(...app.errors.map(error => `App event correlation: ${error}`));
  const episodeCreation = verifyEpisodeCreationCorrelation(loop, lines);
  if (!episodeCreation.ok) {
    errors.push(...episodeCreation.errors.map(error => `episode creation: ${error}`));
  }
  const workstreamCreation = verifyWorkstreamCreationCorrelation(loop, lines);
  if (!workstreamCreation.ok) {
    errors.push(...workstreamCreation.errors.map(error => `workstream creation: ${error}`));
  }
  const proofTransitions = verifyProofTransitionCorrelation(loop, lines);
  if (!proofTransitions.ok) {
    errors.push(...proofTransitions.errors.map(error => `proof transition: ${error}`));
  }
  return { ok: errors.length === 0, errors };
}

function requireVerifiedSnapshot(loop, lines) {
  const verified = verifyRunSnapshot(loop, lines);
  if (!verified.ok) throw new Error(`RUN_SNAPSHOT_INVALID: ${verified.errors.join('; ')}`);
  return loop;
}

export function assertVerifiedRunSnapshot(root, runId, loop, { lines } = {}) {
  if (loop?.run_id !== runId) throw new Error('RUN_SNAPSHOT_INVALID: run_id mismatch');
  assertProjectRootBinding(root, loop);
  return requireVerifiedSnapshot(loop, lines ?? readLines(root, runId));
}

const JOURNAL_NAMES = Object.freeze({
  marker: '.anchored-pending.json', events: '.anchored-events.stage',
  state: '.anchored-state.stage', hash: '.anchored-hash.stage',
  receipt: '.anchored-committed.json',
});
const MARKER_KEYS = Object.freeze([
  'after', 'before', 'caller', 'intent_digest', 'version',
]);
const SNAPSHOT_KEYS = Object.freeze(['events_bytes', 'events_digest', 'hash_bytes',
  'hash_digest', 'state_bytes', 'state_digest']);

function journalPaths(root, runId) {
  const dir = runDir(root, runId);
  return Object.fromEntries(Object.entries(JOURNAL_NAMES)
    .map(([key, name]) => [key, join(dir, name)]));
}

function regularFileIfPresent(path, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`ANCHORED_TRANSACTION_CORRUPT: ${label}`);
  }
  return true;
}

function regularFile(path, label) {
  if (!regularFileIfPresent(path, label)) {
    throw new Error(`ANCHORED_TRANSACTION_CORRUPT: missing ${label}`);
  }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function digestBytes(bytes) { return contentHash(Buffer.from(bytes).toString('base64')); }

function readExactBytes(path, label) {
  regularFile(path, label);
  return readFileSync(path);
}

function syncDirectory(path) { syncParentDirectory(path); }
function syncFile(path) { syncRegularFile(path); }

function durableUnlink(path) {
  try { unlinkRegularFile(path); }
  catch { throw new Error('ANCHORED_TRANSACTION_CORRUPT: durable unlink target'); }
}

function durableReplace(path, bytes, options = {}) {
  try { replaceFileDurably(path, bytes, options); }
  catch (error) {
    if (String(error?.message || error).startsWith('ANCHORED_TRANSACTION_')) throw error;
    throw new Error(`ANCHORED_TRANSACTION_CORRUPT: durable replace: ${error?.message || error}`);
  }
}

function strictSnapshot(value) {
  return exactKeys(value, SNAPSHOT_KEYS)
    && Number.isSafeInteger(value.events_bytes) && value.events_bytes >= 0
    && Number.isSafeInteger(value.state_bytes) && value.state_bytes >= 0
    && Number.isSafeInteger(value.hash_bytes) && value.hash_bytes >= 0
    && [value.events_digest, value.state_digest, value.hash_digest]
      .every(item => /^[0-9a-f]{64}$/.test(item));
}

function readAnchoredMarkerUnderLock(root, runId) {
  const path = journalPaths(root, runId).marker;
  if (!regularFileIfPresent(path, 'marker')) return null;
  let marker;
  try { marker = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('ANCHORED_TRANSACTION_CORRUPT: marker json'); }
  if (!exactKeys(marker, MARKER_KEYS) || marker.version !== 1
      || !exactKeys(marker.caller, ['generation', 'owner'])
      || typeof marker.caller.owner !== 'string'
      || !Number.isSafeInteger(marker.caller.generation) || marker.caller.generation < 1
      || !/^[0-9a-f]{64}$/.test(marker.intent_digest)
      || !strictSnapshot(marker.before) || !strictSnapshot(marker.after)) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: marker shape');
  }
  return Object.freeze(marker);
}

function readCommittedReceiptUnderLock(root, runId) {
  const path = journalPaths(root, runId).receipt;
  if (!regularFileIfPresent(path, 'committed receipt')) return null;
  let receipt;
  try { receipt = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('ANCHORED_TRANSACTION_CORRUPT: committed receipt json'); }
  if (!exactKeys(receipt, MARKER_KEYS) || receipt.version !== 1
      || !exactKeys(receipt.caller, ['generation', 'owner'])
      || typeof receipt.caller.owner !== 'string'
      || !Number.isSafeInteger(receipt.caller.generation) || receipt.caller.generation < 1
      || !/^[0-9a-f]{64}$/.test(receipt.intent_digest)
      || !strictSnapshot(receipt.before) || !strictSnapshot(receipt.after)) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: committed receipt shape');
  }
  return Object.freeze(receipt);
}

function assertNoAnchoredMarkerUnderLock(root, runId) {
  if (readAnchoredMarkerUnderLock(root, runId) !== null) {
    throw new Error('ANCHORED_TRANSACTION_PENDING');
  }
  const paths = journalPaths(root, runId);
  const knownOrphans = new Map(Object.values(paths)
    .flatMap(path => path === paths.marker
      ? [[`${path}.replace`, `${path}.replace`]]
      : [[path, path], [`${path}.replace`, `${path}.replace`]]));
  for (const name of readdirSync(runDir(root, runId))) {
    if (!name.startsWith('.anchored-')) continue;
    const path = join(runDir(root, runId), name);
    if (!knownOrphans.has(path)) {
      throw new Error('ANCHORED_TRANSACTION_CORRUPT: unknown journal artifact');
    }
    if (path === paths.receipt) {
      regularFile(path, 'committed receipt');
      continue;
    }
    durableUnlink(path);
  }
}

function assertKnownAnchoredArtifactsUnderLock(root, runId, paths) {
  const known = new Set(Object.values(paths).map(path => basename(path)));
  for (const name of readdirSync(runDir(root, runId))) {
    if (!name.startsWith('.anchored-')) continue;
    const path = join(runDir(root, runId), name);
    if (!known.has(name)) {
      throw new Error('ANCHORED_TRANSACTION_CORRUPT: unknown journal artifact');
    }
    regularFile(path, 'journal artifact');
  }
}

function readCurrentRunIdUnderLock(root) {
  const current = join(root, '.deep-loop', 'current');
  if (!regularFileIfPresent(current, 'current pointer')) return null;
  const value = readFileSync(current, 'utf8').trim();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
    throw new Error('CURRENT_RUN_ID_INVALID');
  }
  return value;
}

function journalSnapshot(events, state, hash) {
  return { events_bytes: events.length, events_digest: digestBytes(events),
    state_bytes: state.length, state_digest: digestBytes(state),
    hash_bytes: hash.length, hash_digest: digestBytes(hash) };
}

function assertSnapshotBytes(snapshot, events, state, hash, label) {
  const actual = journalSnapshot(events, state, hash);
  if (JSON.stringify(actual) !== JSON.stringify(snapshot)) {
    throw new Error(`ANCHORED_TRANSACTION_CORRUPT: ${label}`);
  }
}

function removeJournal(paths, marker) {
  for (const key of ['events', 'state', 'hash']) {
    durableUnlink(paths[key]);
    crashIfScheduled(`cleanup-${key}-after-unlink`);
  }
  // The marker remains authoritative until every disposable stage is gone. Publish one bounded
  // last-commit receipt before removing it so a lost response can still recover the exact durable
  // caller/intent/result without retaining an unbounded journal.
  durableReplace(paths.receipt, Buffer.from(JSON.stringify(marker)));
  durableUnlink(paths.marker);
  crashIfScheduled('cleanup-marker-after-unlink');
}

function snapshotBytesMatch(snapshot, events, state, hash) {
  return JSON.stringify(journalSnapshot(events, state, hash)) === JSON.stringify(snapshot);
}

function frozenRecoveredEvents(bytes) {
  const events = bytes.toString('utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
  return Object.freeze({ events: Object.freeze(events.map(event =>
    Object.freeze(structuredClone(event)))) });
}

function recoverAnchoredTransactionUnderLock(root, runId, marker) {
  const paths = journalPaths(root, runId);
  // Reject unknown or symlinked journal names before reading or changing canonical bytes.
  assertKnownAnchoredArtifactsUnderLock(root, runId, paths);
  const eventPath = logPath(root, runId);
  const statePath = join(runDir(root, runId), 'loop.json');
  const hashPath = join(runDir(root, runId), '.loop.hash');
  const canonicalEvents = regularFileIfPresent(eventPath, 'canonical event log')
    ? readFileSync(eventPath) : Buffer.alloc(0);
  const canonicalState = readExactBytes(statePath, 'canonical state');
  const canonicalHash = readExactBytes(hashPath, 'canonical hash');
  const beforeLength = marker.before.events_bytes;
  const canonicalAfter = snapshotBytesMatch(marker.after,
    canonicalEvents, canonicalState, canonicalHash);
  if (canonicalAfter) {
    const suffix = canonicalEvents.subarray(beforeLength);
    for (const [key, expected] of [
      ['events', suffix], ['state', canonicalState], ['hash', canonicalHash],
    ]) {
      if (regularFileIfPresent(paths[key], `${key} stage`)
          && !readFileSync(paths[key]).equals(expected)) {
        throw new Error(`ANCHORED_TRANSACTION_CORRUPT: ${key} cleanup stage`);
      }
    }
    const recovered = frozenRecoveredEvents(suffix);
    removeJournal(paths, marker);
    crashIfScheduled('response-after-cleanup');
    return recovered;
  }
  const stagedEvents = readExactBytes(paths.events, 'events stage');
  const stagedState = readExactBytes(paths.state, 'state stage');
  const stagedHash = readExactBytes(paths.hash, 'hash stage');
  if (canonicalEvents.length < beforeLength
      || canonicalEvents.length > beforeLength + stagedEvents.length) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: event length');
  }
  const canonicalPrefix = canonicalEvents.subarray(0, beforeLength);
  if (digestBytes(canonicalPrefix) !== marker.before.events_digest) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: event prefix');
  }
  // Authenticate the complete after image before changing any canonical byte. Never replace the
  // marker's event digest with a digest recomputed from the untrusted stage itself.
  const stagedAfterEvents = Buffer.concat([canonicalPrefix, stagedEvents]);
  assertSnapshotBytes(marker.after, stagedAfterEvents, stagedState, stagedHash, 'stage digest');
  const partial = canonicalEvents.subarray(beforeLength);
  if (!stagedEvents.subarray(0, partial.length).equals(partial)) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: event suffix');
  }
  const stateBefore = canonicalState.length === marker.before.state_bytes
    && digestBytes(canonicalState) === marker.before.state_digest;
  const stateAfter = canonicalState.length === marker.after.state_bytes
    && digestBytes(canonicalState) === marker.after.state_digest;
  const hashBefore = canonicalHash.length === marker.before.hash_bytes
    && digestBytes(canonicalHash) === marker.before.hash_digest;
  const hashAfter = canonicalHash.length === marker.after.hash_bytes
    && digestBytes(canonicalHash) === marker.after.hash_digest;
  const fullyAppended = partial.length === stagedEvents.length;
  // These fixed scratch names may be partial after a real process death. They carry no authority;
  // a matching marker retry discards them and republishes from the authenticated stages.
  durableUnlink(`${statePath}.replace`);
  durableUnlink(`${hashPath}.replace`);
  if (stateBefore && hashBefore) {
    if (regularFileIfPresent(eventPath, 'canonical event log')) truncateSync(eventPath, beforeLength);
    else if (beforeLength !== 0) {
      throw new Error('ANCHORED_TRANSACTION_CORRUPT: missing event prefix');
    }
    appendFileSync(eventPath, stagedEvents);
    syncFile(eventPath);
    syncDirectory(eventPath);
    durableReplace(statePath, stagedState);
    durableReplace(hashPath, stagedHash);
  } else if (stateAfter && hashBefore && fullyAppended) {
    // `state-after-rename` is a valid intermediate commit point: events and
    // state are already durable, while the hash is still the before image.
    durableReplace(hashPath, stagedHash);
  } else if (!(stateAfter && hashAfter && fullyAppended)) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: canonical state pair');
  }
  const finalEvents = readFileSync(eventPath);
  const finalState = readFileSync(statePath);
  const finalHash = readFileSync(hashPath);
  assertSnapshotBytes(marker.after, finalEvents, finalState, finalHash, 'recovered candidate');
  const recovered = frozenRecoveredEvents(stagedEvents);
  removeJournal(paths, marker);
  crashIfScheduled('response-after-cleanup');
  return recovered;
}

const JOURNAL_CRASH_POINTS = new Set([
  'state-stage-after-rename', 'event-stage-after-rename', 'pending-after-rename',
  'event-after-partial-append', 'event-after-full-append', 'state-after-rename',
  'hash-after-rename', 'before-cleanup',
  'state-replace-after-create', 'state-replace-after-fsync',
  'state-replace-after-rename-before-dir-fsync',
  'hash-replace-after-create', 'hash-replace-after-fsync',
  'hash-replace-after-rename-before-dir-fsync',
  'cleanup-events-after-unlink', 'cleanup-state-after-unlink',
  'cleanup-hash-after-unlink', 'cleanup-marker-after-unlink',
  'response-after-cleanup',
]);

function crashIfScheduled(stage) {
  const selected = process.env.NODE_ENV === 'test'
    ? process.env.DEEP_LOOP_TEST_CRASH_AT : undefined;
  if (selected === undefined) return;
  if (!JOURNAL_CRASH_POINTS.has(selected)) {
    throw new Error('ANCHORED_TEST_CRASH_POINT_INVALID');
  }
  if (selected === stage) process.exit(91);
}

function publishAnchoredCandidateUnderLock(root, runId, {
  candidate, prospective, callerBinding, intentDigest,
}) {
  const paths = journalPaths(root, runId);
  assertNoAnchoredMarkerUnderLock(root, runId);
  const eventPath = logPath(root, runId);
  const statePath = join(runDir(root, runId), 'loop.json');
  const hashPath = join(runDir(root, runId), '.loop.hash');
  const beforeEvents = regularFileIfPresent(eventPath, 'canonical event log')
    ? readFileSync(eventPath) : Buffer.alloc(0);
  const beforeState = readExactBytes(statePath, 'canonical state');
  const beforeHash = readExactBytes(hashPath, 'canonical hash');
  const allEvents = Buffer.from(prospective.map(event => `${JSON.stringify(event)}\n`).join(''));
  if (!allEvents.subarray(0, beforeEvents.length).equals(beforeEvents)) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: prospective prefix');
  }
  const stagedEvents = allEvents.subarray(beforeEvents.length);
  const stagedState = Buffer.from(JSON.stringify(candidate, null, 2));
  const stagedHash = Buffer.from(contentHash(stagedState.toString('utf8')));
  const marker = { version: 1,
    caller: { owner: callerBinding.owner, generation: callerBinding.generation },
    intent_digest: intentDigest,
    before: journalSnapshot(beforeEvents, beforeState, beforeHash),
    after: journalSnapshot(allEvents, stagedState, stagedHash) };
  durableReplace(paths.state, stagedState); crashIfScheduled('state-stage-after-rename');
  durableReplace(paths.events, stagedEvents); crashIfScheduled('event-stage-after-rename');
  durableReplace(paths.hash, stagedHash);
  durableReplace(paths.marker, Buffer.from(JSON.stringify(marker)));
  crashIfScheduled('pending-after-rename');
  const split = Math.max(1, Math.floor(stagedEvents.length / 2));
  appendFileSync(eventPath, stagedEvents.subarray(0, split));
  syncFile(eventPath); syncDirectory(eventPath);
  crashIfScheduled('event-after-partial-append');
  appendFileSync(eventPath, stagedEvents.subarray(split));
  syncFile(eventPath);
  crashIfScheduled('event-after-full-append');
  durableReplace(statePath, stagedState, { label: 'state' });
  crashIfScheduled('state-after-rename');
  durableReplace(hashPath, stagedHash, { label: 'hash' });
  crashIfScheduled('hash-after-rename');
  crashIfScheduled('before-cleanup'); removeJournal(paths, marker);
  crashIfScheduled('response-after-cleanup');
}

function recoverCommittedReceiptUnderLock(root, runId, receipt) {
  const eventPath = logPath(root, runId);
  const events = regularFileIfPresent(eventPath, 'canonical event log')
    ? readFileSync(eventPath) : Buffer.alloc(0);
  const state = readExactBytes(join(runDir(root, runId), 'loop.json'), 'canonical state');
  const hash = readExactBytes(join(runDir(root, runId), '.loop.hash'), 'canonical hash');
  if (!snapshotBytesMatch(receipt.after, events, state, hash)) {
    const stateMatches = state.length === receipt.after.state_bytes
      && digestBytes(state) === receipt.after.state_digest;
    const hashMatches = hash.length === receipt.after.hash_bytes
      && digestBytes(hash) === receipt.after.hash_digest;
    // If the canonical state/hash still are the receipt's exact after image, a divergent event
    // claim is receipt corruption, not an older receipt displaced by later state.
    if (stateMatches && hashMatches && events.length === receipt.after.events_bytes) {
      throw new Error('ANCHORED_TRANSACTION_CORRUPT: committed receipt snapshot');
    }
    return null;
  }
  const boundary = receipt.before.events_bytes;
  if (boundary < 0 || boundary >= receipt.after.events_bytes
      || boundary > events.length
      || (boundary > 0 && events[boundary - 1] !== 0x0a)) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: committed receipt event range');
  }
  const prefix = events.subarray(0, boundary);
  if (digestBytes(prefix) !== receipt.before.events_digest) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: committed receipt event prefix');
  }
  return frozenRecoveredEvents(events.subarray(boundary, receipt.after.events_bytes));
}

function readVerifiedStateUnderLock(root, runId, { fenceCheck } = {}) {
  const state = readState(root, runId);
  if (fenceCheck !== undefined) {
    if (typeof fenceCheck !== 'function') throw new Error('INVALID_FENCE_CHECK');
    fenceCheck(state.data);
  }
  const lines = readLines(root, runId);
  assertVerifiedRunSnapshot(root, runId, state.data, { lines });
  return { data: structuredClone(state.data), hash: state.hash };
}

function pendingAuthenticationStateUnderLock(root, runId, marker,
  { allowUnboundRoot = false } = {}) {
  const stateBytes = readExactBytes(join(runDir(root, runId), 'loop.json'),
    'pending authentication state');
  const matches = [marker.before, marker.after].some(snapshot =>
    stateBytes.length === snapshot.state_bytes
      && digestBytes(stateBytes) === snapshot.state_digest);
  if (!matches) {
    throw new Error('ANCHORED_TRANSACTION_CORRUPT: authentication state');
  }
  let loop;
  try { loop = JSON.parse(stateBytes.toString('utf8')); }
  catch { throw new Error('ANCHORED_TRANSACTION_CORRUPT: authentication state json'); }
  if (!allowUnboundRoot) assertProjectRootBinding(root, loop);
  return loop;
}

export function authenticateVerifiedMutationCaller(root, runId, {
  callerBinding, fenceCheck, fenceError = 'LEASE_FENCED: mutation-authentication',
} = {}) {
  const binding = requireCallerBinding(callerBinding);
  if (typeof fenceCheck !== 'function') throw new Error('INVALID_FENCE_CHECK');
  return withLock(root, runId, () => {
    const marker = readAnchoredMarkerUnderLock(root, runId);
    if (marker !== null) {
      if (marker.caller.owner !== binding.owner
          || marker.caller.generation !== binding.generation) {
        throw new Error(fenceError);
      }
      // Authentication only: a pending transaction may leave the canonical state at either the
      // exact before or exact after image. The final intent-aware gateway alone may recover it.
      const loop = pendingAuthenticationStateUnderLock(root, runId, marker);
      fenceCheck(loop);
      return Object.freeze({ pending: true });
    }
    readVerifiedStateUnderLock(root, runId, { fenceCheck });
    return Object.freeze({ pending: false });
  });
}

export function readAuthenticatedMutationSnapshot(root, runId, {
  callerBinding, fenceCheck, fenceError = 'LEASE_FENCED: mutation-snapshot',
} = {}) {
  const binding = requireCallerBinding(callerBinding);
  if (typeof fenceCheck !== 'function') throw new Error('INVALID_FENCE_CHECK');
  if (typeof fenceError !== 'string' || fenceError.length === 0) {
    throw new Error('MUTATION_FENCE_ERROR_REQUIRED');
  }
  return withLock(root, runId, () => {
    // Strict marker parsing is deliberately the first durable read. This API authenticates a
    // snapshot for request construction only; it never recovers or cleans any transaction bytes.
    const marker = readAnchoredMarkerUnderLock(root, runId);
    if (marker !== null) {
      if (marker.caller.owner !== binding.owner
          || marker.caller.generation !== binding.generation) {
        throw new Error(fenceError);
      }
      const loop = pendingAuthenticationStateUnderLock(root, runId, marker);
      fenceCheck(loop);
      return Object.freeze({ data: structuredClone(loop), pending: true });
    }
    const verified = readVerifiedStateUnderLock(root, runId, { fenceCheck });
    return Object.freeze({ data: verified.data, pending: false });
  });
}

export function readVerifiedState(root, runId, options = {}) {
  return withLock(root, runId, () => {
    if (readAnchoredMarkerUnderLock(root, runId) !== null) {
      throw new Error('ANCHORED_TRANSACTION_PENDING');
    }
    return readVerifiedStateUnderLock(root, runId, options);
  });
}

function spentOfLines(lines) {
  return lines.filter(event => event.type === 'cost').reduce((acc, event) => {
    if (!validCost(event.data)) {
      throw new Error(`LOG_CORRUPT: invalid cost event at seq ${event.seq}`);
    }
    return { turns: acc.turns + event.data.turns,
      tokens: acc.tokens + event.data.tokens };
  }, { turns: 0, tokens: 0 });
}

function requireCallerBinding(binding) {
  if (typeof binding?.owner !== 'string' || binding.owner.length === 0
      || !Number.isSafeInteger(binding?.generation) || binding.generation < 1) {
    throw new Error('CALLER_BINDING_REQUIRED');
  }
  return Object.freeze({ owner: binding.owner, generation: binding.generation });
}

export function withVerifiedMutationLock(root, runId,
  { callerBinding, intentDigest, fenceError,
    intentConflictError = 'ANCHORED_TRANSACTION_PENDING',
    allowUnboundRoot = false }, body) {
  const binding = requireCallerBinding(callerBinding);
  if (!/^[0-9a-f]{64}$/.test(intentDigest || '') || typeof body !== 'function') {
    throw new Error('MUTATION_INTENT_REQUIRED');
  }
  if (typeof fenceError !== 'string' || fenceError.length === 0) {
    throw new Error('MUTATION_FENCE_ERROR_REQUIRED');
  }
  return withLock(root, runId, () => {
    let recovered = null;
    let recoverySource = null;
    // This strict marker read is deliberately before readState/readLines/root/schema verification.
    const marker = readAnchoredMarkerUnderLock(root, runId);
    if (marker !== null) {
      if (marker.caller.owner !== binding.owner
          || marker.caller.generation !== binding.generation) {
        throw new Error(fenceError);
      }
      if (marker.intent_digest !== intentDigest) {
        throw new Error(intentConflictError);
      }
      pendingAuthenticationStateUnderLock(root, runId, marker, { allowUnboundRoot });
      // Uses raw exact before/after bytes recorded by the marker, not canonical public readers.
      recovered = recoverAnchoredTransactionUnderLock(root, runId, marker);
      recoverySource = 'pending';
    } else {
      // Pre-marker stages have no authority and are safe to discard only on a mutation entry.
      // The bounded committed receipt is preserved and may prove an exact response-loss retry.
      assertNoAnchoredMarkerUnderLock(root, runId);
      const receipt = readCommittedReceiptUnderLock(root, runId);
      if (receipt !== null
          && receipt.caller.owner === binding.owner
          && receipt.caller.generation === binding.generation
          && receipt.intent_digest === intentDigest) {
        recovered = recoverCommittedReceiptUnderLock(root, runId, receipt);
        if (recovered !== null) recoverySource = 'receipt';
      }
    }
    // Logical restart: the complete public operation begins its normal read/idempotency path only now.
    let active = true;
    const assertActive = () => {
      if (!active) throw new Error('MUTATION_CONTEXT_EXPIRED');
    };
    const context = Object.freeze({
      recovered,
      recoverySource,
      readVerifiedState(options = {}) {
        assertActive();
        return readVerifiedStateUnderLock(root, runId, options);
      },
      appendAnchored(event, mutate, preCheck, opts = {}) {
        assertActive();
        return appendAnchoredUnderLock(root, runId, event, mutate, preCheck, opts,
          { callerBinding: binding, intentDigest });
      },
    });
    try {
      return body(context);
    } finally {
      active = false;
    }
  });
}

function legacyCheckpointSpec(root, runId, loop, lines,
  { callerBinding, now }) {
  if (loop.initialization !== undefined) return null;
  const baselines = lines.filter(event => event?.type === 'lease-lineage-baselined');
  if (baselines.length > 0) return null;
  const lease = loop.session_chain?.lease ?? {};
  const incompatible = loop.autonomy?.app_task_continuation?.mode === 'auto'
    || (loop.session_chain?.sessions ?? []).some(session =>
      session?.host_surface != null || session?.continuation?.transport === 'codex-app')
    || lines.some(event => ['lease-acquired', 'app-task-acquired']
      .includes(event?.type));
  if (incompatible || readCurrentRunIdUnderLock(root) !== runId
      || callerBinding.owner !== lease.owner_run_id
      || callerBinding.generation !== lease.generation
      || typeof lease.owner_run_id !== 'string'
      || !Number.isSafeInteger(lease.generation) || lease.generation < 1
      || typeof lease.acquired_at !== 'string'
      || !Number.isFinite(Date.parse(lease.acquired_at))
      || new Date(Date.parse(lease.acquired_at)).toISOString() !== lease.acquired_at
      || !['active', 'releasing', 'released'].includes(lease.state)) {
    throw new Error('LEGACY_LINEAGE_CHECKPOINT_INELIGIBLE');
  }
  const legacyEpisodeCount = (loop.episodes || []).length;
  const legacyWorkstreamCount = (loop.workstreams || []).length;
  return { type: 'lease-lineage-baselined', now, data: {
    owner_run_id: lease.owner_run_id, generation: lease.generation,
    lease_state: lease.state, acquired_at: lease.acquired_at,
    legacy_episode_count: legacyEpisodeCount,
    legacy_workstream_count: legacyWorkstreamCount,
    legacy_active_workstreams: structuredClone(loop.active_workstreams),
    legacy_proof_origins: legacyProofOrigins(
      loop, legacyEpisodeCount, legacyWorkstreamCount),
    legacy_authority_digest: legacyAuthorityDigest(loop),
  } };
}

// Callers must already own the run lock through withVerifiedMutationLock. Only appendAnchored,
// generic lease/accounting writers, and the fixed root-rebind commit may import this export.
export function commitVerifiedEventsUnderLock(root, runId, loop, eventSpecs, mutate,
  options = {}) {
  if (Object.values(options).some(value => typeof value === 'function')) {
    throw new Error('LOCK_HELD_CALLBACK_FORBIDDEN');
  }
  const { baseLines, baseStateHash, callerBinding, intentDigest } = options;
  if (!Array.isArray(eventSpecs) || eventSpecs.length === 0) {
    throw new Error('VERIFIED_COMMIT_EVENTS_REQUIRED');
  }
  const binding = requireCallerBinding(callerBinding);
  if (!Array.isArray(baseLines) || !/^[0-9a-f]{64}$/.test(baseStateHash || '')
      || !/^[0-9a-f]{64}$/.test(intentDigest || '')) {
    throw new Error('VERIFIED_COMMIT_BASE_REQUIRED');
  }
  if (eventSpecs.some(spec => spec?.type === 'lease-lineage-baselined')) {
    throw new Error('LEGACY_CHECKPOINT_CALLER_FORBIDDEN');
  }
  assertNoAnchoredMarkerUnderLock(root, runId);
  if (loop?.run_id !== runId) throw new Error('RUN_SNAPSHOT_INVALID: run_id mismatch');
  const lines = baseLines;
  requireVerifiedSnapshot(loop, lines);
  const preCheckpointLegacy = loop.initialization === undefined
    && !lines.some(event => event?.type === 'lease-lineage-baselined');
  const proofBefore = structuredClone(loop);
  if (preCheckpointLegacy) {
    loop.active_workstreams = normalizeLegacyActiveWorkstreams(loop);
    loop.legacy_lineage = {
      active_workstreams: structuredClone(loop.active_workstreams),
    };
    proofBefore.active_workstreams = structuredClone(loop.active_workstreams);
    proofBefore.legacy_lineage = structuredClone(loop.legacy_lineage);
  }
  const checkpoint = legacyCheckpointSpec(root, runId, proofBefore, lines, {
    callerBinding: binding, now: eventSpecs[0].now,
  });
  const preparedSpecs = structuredClone(
    checkpoint === null ? eventSpecs : [checkpoint, ...eventSpecs]);
  const draftProspective = [...lines];
  const draftCommitted = [];
  for (const spec of preparedSpecs) {
    if (!spec || typeof spec.type !== 'string' || spec.type.length === 0) {
      throw new Error('VERIFIED_COMMIT_EVENT_INVALID');
    }
    const event = nextEvent(draftProspective, { type: spec.type,
      data: structuredClone(spec.data), now: spec.now });
    draftProspective.push(event); draftCommitted.push(event);
  }
  // The mutator may consume only stable seq/ts/type/data from draft business events. Checksums and
  // event-log head are rebuilt after the candidate-derived proof transitions are attached.
  const draftBusiness = checkpoint === null ? draftCommitted : draftCommitted.slice(1);
  // Preserve the historical appendAnchored callback contract: preCheck and mutate observe the
  // same in-lock object identity. Several transitional callers intentionally bind entity objects
  // during preCheck and update those exact objects in mutate. `proofBefore` is the immutable
  // prospective baseline; the freshly read `loop` is the unpublished candidate.
  const candidate = loop;
  candidate.event_log_head = headOfLines(draftProspective);
  const draftSpent = spentOfLines(draftProspective);
  if (mutate) mutate(candidate, draftSpent, draftBusiness);
  candidate.updated_at = draftCommitted.at(-1).ts;

  const finalSpecs = draftCommitted.map(event => ({ type: event.type,
    data: structuredClone(event.data), now: event.ts }));
  attachCandidateProofTransitions(proofBefore, candidate, finalSpecs);
  const prospective = [...lines];
  const allCommitted = [];
  for (const spec of finalSpecs) {
    const event = nextEvent(prospective, spec);
    prospective.push(event); allCommitted.push(event);
  }
  candidate.event_log_head = headOfLines(prospective);
  const spent = spentOfLines(prospective);
  assertVerifiedRunSnapshot(root, runId, candidate, { lines: prospective });
  publishAnchoredCandidateUnderLock(root, runId, {
    beforeLoop: loop, beforeLines: lines, candidate, prospective,
    committed: allCommitted, callerBinding: binding, intentDigest,
  });
  const committed = checkpoint === null ? allCommitted : allCommitted.slice(1);
  return { candidate, committed, spent };
}

function appendAnchoredUnderLock(root, runId, { type, data }, mutate, preCheck, opts,
  { callerBinding: binding, intentDigest }) {
    const { data: loop, hash: baseStateHash } = readState(root, runId);
    assertProjectRootBinding(root, loop);
    const splitFence = opts.fenceCheck !== undefined;
    if (splitFence && typeof opts.fenceCheck !== 'function') {
      throw new Error('INVALID_FENCE_CHECK');
    }
    if (splitFence) opts.fenceCheck(loop);
    let clock;
    if (opts.nowFn !== undefined) {
      if (typeof opts.nowFn !== 'function') throw new Error('INVALID_NOW: nowFn');
      const sampled = opts.nowFn();
      if (typeof sampled !== 'number' || !Number.isFinite(sampled)
          || !Number.isFinite(new Date(sampled).getTime())) {
        throw new Error('INVALID_NOW: anchored clock');
      }
      clock = Object.freeze({ ms: sampled, iso: new Date(sampled).toISOString() });
    }
    if (!splitFence && preCheck) preCheck(loop, clock);
    const lines = readLines(root, runId);
    requireVerifiedSnapshot(loop, lines);
    if (splitFence && preCheck) preCheck(loop, clock);
    if ((loop.status === 'completed' || loop.status === 'stopped') && opts.allowTerminal !== true) {
      throw new Error('RUN_TERMINAL: append');
    }
    const eventSpecs = [{ type, data, now: clock?.ms }];
    if (opts.floor) {
      const lease = loop.session_chain?.lease || {};
      eventSpecs.push({ type: 'cost', now: clock?.ms, data: {
        turns: opts.floor, tokens: 0, auto_floor: true, for: type,
        owner: lease.owner_run_id, generation: lease.generation,
      } });
    }
    commitVerifiedEventsUnderLock(root, runId, loop, eventSpecs,
      (candidate, spent) => {
        if (opts.floor) {
          candidate.budget.spent = spent.turns;
          candidate.budget.tokens_spent = spent.tokens;
          const owner = candidate.session_chain?.lease?.owner_run_id;
          const session = (candidate.session_chain?.sessions || [])
            .find(item => item.run_id === owner);
          if (session) session.turns = (session.turns || 0) + opts.floor;
        }
        if (mutate) mutate(candidate, spent, clock);
      }, { baseLines: lines, baseStateHash,
        callerBinding: binding, intentDigest });
}

function transitionalDirectIntent(event) {
  if (typeof event?.type !== 'string' || event.type.length === 0) {
    throw new Error('MUTATION_INTENT_REQUIRED');
  }
  return contentHash(JSON.stringify({ operation: 'transitional-direct-append',
    type: event.type, data: event.data }));
}

function appendTransitionalDirect(root, runId, event, mutate, preCheck, opts) {
  const intentDigest = transitionalDirectIntent(event);
  return withLock(root, runId, () => {
    const marker = readAnchoredMarkerUnderLock(root, runId);
    if (marker !== null) {
      if (marker.intent_digest !== intentDigest) {
        throw new Error('ANCHORED_TRANSACTION_PENDING');
      }
      const pending = pendingAuthenticationStateUnderLock(root, runId, marker);
      const lease = pending.session_chain?.lease;
      if (lease?.owner_run_id !== marker.caller.owner
          || lease?.generation !== marker.caller.generation) {
        throw new Error('ANCHORED_TRANSACTION_PENDING');
      }
      if (typeof opts.fenceCheck === 'function') opts.fenceCheck(pending);
      else if (preCheck) preCheck(pending);
      const recovered = recoverAnchoredTransactionUnderLock(root, runId, marker);
      const verified = readVerifiedStateUnderLock(root, runId);
      return typeof opts.onRecovered === 'function'
        ? opts.onRecovered(verified.data, recovered) : undefined;
    }
    const verified = readVerifiedStateUnderLock(root, runId,
      typeof opts.fenceCheck === 'function' ? { fenceCheck: opts.fenceCheck } : {});
    const lease = verified.data.session_chain?.lease;
    const callerBinding = requireCallerBinding({ owner: lease?.owner_run_id,
      generation: lease?.generation });
    return appendAnchoredUnderLock(root, runId, event, mutate, preCheck, opts,
      { callerBinding, intentDigest });
  });
}

export function appendAnchored(root, runId, event, mutate, preCheck, opts = {}) {
  const hasBinding = opts.callerBinding !== undefined;
  const hasIntent = opts.intentDigest !== undefined;
  if (!hasBinding && !hasIntent) {
    return appendTransitionalDirect(root, runId, event, mutate, preCheck, opts);
  }
  if (hasBinding !== hasIntent) throw new Error('MUTATION_AUTHORITY_INCOMPLETE');
  const binding = requireCallerBinding(opts.callerBinding);
  const intentDigest = opts.intentDigest;
  // There is deliberately no event-only fallback: event payloads may redact or omit business
  // inputs. Every public mutation must bind its complete request before lock acquisition.
  if (!/^[0-9a-f]{64}$/.test(intentDigest || '')) {
    throw new Error('MUTATION_INTENT_REQUIRED');
  }
  return withVerifiedMutationLock(root, runId, {
    callerBinding: binding, intentDigest,
    fenceError: opts.fenceError ?? 'LEASE_FENCED: append',
  }, mutation => {
    // An exact marker retry has already durably committed this direct append. Prove the recovered
    // snapshot, but never execute mutate/preCheck a second time or append a duplicate business event.
    // Operation wrappers that owe a structured response derive it from this proved snapshot.
    if (mutation.recovered) {
      const recovered = mutation.readVerifiedState();
      return typeof opts.onRecovered === 'function'
        ? opts.onRecovered(recovered.data, mutation.recovered) : undefined;
    }
    return mutation.appendAnchored(event, mutate, preCheck, opts);
  });
}


export function intentField(domain, value) {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new Error('MUTATION_INTENT_REQUIRED');
  }
  let encoded;
  try {
    encoded = value === undefined
      ? JSON.stringify({ kind: 'undefined' })
      : JSON.stringify({ kind: value === null ? 'null' : typeof value, value });
  } catch { throw new Error('MUTATION_INTENT_REQUIRED'); }
  if (typeof encoded !== 'string') throw new Error('MUTATION_INTENT_REQUIRED');
  return contentHash(`${domain}\0${encoded}`);
}

export function mutationIntentDigest(operation, callerBinding, projection) {
  if (typeof operation !== 'string' || operation.length === 0
      || projection === null || typeof projection !== 'object' || Array.isArray(projection)) {
    throw new Error('MUTATION_INTENT_REQUIRED');
  }
  const binding = requireCallerBinding(callerBinding);
  return contentHash(JSON.stringify({ ...projection, operation,
    owner: binding.owner, generation: binding.generation }));
}

export function directMutationOptions(operation, callerBinding, completeRequest,
  fenceError, { onRecovered, ...extra } = {}) {
  if (typeof fenceError !== 'string' || fenceError.length === 0) {
    throw new Error('MUTATION_FENCE_ERROR_REQUIRED');
  }
  const binding = requireCallerBinding(callerBinding);
  const intentDigest = mutationIntentDigest(operation, binding, {
    request_digest: intentField(`${operation}-request`, completeRequest),
  });
  return Object.freeze({ ...extra, callerBinding: binding, intentDigest, fenceError,
    ...(onRecovered === undefined ? {} : { onRecovered }) });
}

// These two redaction-sensitive examples are mandatory shapes, not illustrative fallbacks.
// The state-patch event omits value and workstream-new omits most business inputs, so the request
// intent must carry bounded digests for every omitted behavior input.
export function statePatchIntent(fence, field, value) {
  return mutationIntentDigest('state-patch', fence,
    { field, value_digest: intentField('state-patch-value', value) });
}

export function workstreamNewIntent(fence,
  { title, branch, worktree, baseCommit, dependsOn, requestIdDigest, requestDigest }) {
  return mutationIntentDigest('workstream-new', fence, {
    request_id_digest: requestIdDigest,
    request_digest: requestDigest,
    title_digest: intentField('workstream-title', title),
    branch_digest: intentField('workstream-branch', branch),
    worktree_digest: intentField('workstream-path', worktree),
    base_commit_digest: intentField('workstream-base', baseCommit),
    depends_on_digest: intentField('workstream-dependencies', dependsOn),
  });
}


export function commitProjectRootRebindUnderLock(root, runId, loop,
  { oldRootDigest, newRoot, now, baseStateHash, callerBinding, intentDigest }) {
  if (!loop || typeof loop !== 'object' || loop.run_id !== runId) {
    throw new Error('STATE_INVALID: loop.run_id mismatch');
  }
  if (!/^[0-9a-f]{64}$/.test(oldRootDigest || '')
      || projectRootDigest(loop.project?.root) !== oldRootDigest) {
    throw new Error('INVALID_STORED_ROOT_DIGEST: stored root changed');
  }
  let canonicalRoot;
  try {
    canonicalRoot = canonicalProjectRoot(root);
    if (canonicalProjectRoot(newRoot) !== canonicalRoot || newRoot !== canonicalRoot) {
      throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate root identity changed');
    }
  } catch (error) {
    if (String(error?.message || error)
        === 'PROJECT_ROOT_UNRESOLVABLE: candidate root identity changed') throw error;
    throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate root', { cause: error });
  }

  const lines = readLines(root, runId);
  requireVerifiedSnapshot(loop, lines);
  const data = { old_root_digest: oldRootDigest, new_root: canonicalRoot };
  commitVerifiedEventsUnderLock(root, runId, loop,
    [{ type: 'project-root-rebound', data, now }], candidate => {
      candidate.project.root = canonicalRoot;
    }, { baseLines: lines, baseStateHash, callerBinding, intentDigest });
  return { ok: true };
}
