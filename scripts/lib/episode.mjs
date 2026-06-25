import { mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { readState, writeState, withLock, runDir } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { atomicWrite } from './envelope.mjs';
import { slugify } from './slug.mjs';
import { leaseCheck } from './lease.mjs';

const NON_TERMINAL = ['pending', 'in_progress', 'blocked'];
const TERMINAL = ['done', 'approved', 'rejected'];

function requestSkeleton({ id, plugin, role, kind, point, workstream, expectedArtifacts }) {
  return [
    `# Episode ${id} — request`, '',
    `- plugin: ${plugin}`, `- role: ${role}`, `- kind: ${kind}`,
    `- review point: ${point}`, `- workstream: ${workstream || '(none)'}`, '',
    '## Task', '', '<!-- Execution plane: fill the maker/checker task here -->', '',
    '## Expected artifacts', '', ...(expectedArtifacts.length ? expectedArtifacts.map(a => `- ${a}`) : ['- <!-- list proof artifacts -->']), '',
    '## Constraints', '', '- 이전 대화 컨텍스트를 가정하지 말라. loop.json + 이 request가 source of truth.', '',
  ].join('\n');
}

export function newEpisode(root, runId, { plugin, role, kind, point, workstream = null, expectedArtifacts = [], targetMaker, fence } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: newEpisode');
  // Fix 3: validate required non-fence args before any state write
  if (!plugin || typeof plugin !== 'string' || !plugin.length) throw new Error('EPISODE_INPUT_INVALID: plugin');
  if (!role || typeof role !== 'string' || !role.length) throw new Error('EPISODE_INPUT_INVALID: role');
  if (!['maker', 'checker'].includes(role)) throw new Error('EPISODE_INPUT_INVALID: role');
  if (!kind || typeof kind !== 'string' || !kind.length) throw new Error('EPISODE_INPUT_INVALID: kind');
  if (!point || typeof point !== 'string' || !point.length) throw new Error('EPISODE_INPUT_INVALID: point');
  // Codex impl r7 🔴: expectedArtifacts must be an array of strings (a null/non-array would throw in the
  // loop below; though that is before appendAnchored, give a clean error rather than a raw TypeError).
  if (!Array.isArray(expectedArtifacts) || !expectedArtifacts.every(a => typeof a === 'string')) throw new Error('EPISODE_INPUT_INVALID: expectedArtifacts must be an array of strings');
  // Codex r2 🟡: expectedArtifacts 경로 안전성 검증 — 절대 경로 및 '..' 세그먼트 사전 차단.
  for (const a of expectedArtifacts) {
    if (isAbsolute(a) || a.split(/[/\\]/).includes('..')) throw new Error('EPISODE_ARTIFACT_UNSAFE: ' + a);
  }
  let id, requestPath, dir;
  const safePlugin = slugify(plugin) || 'plugin';
  appendAnchored(root, runId, { type: 'episode-new', data: { plugin, role, kind, point } }, (loop) => {
    const n = String(loop.episodes.length + 1).padStart(3, '0');
    id = `${n}-${safePlugin}`;
    dir = join(runDir(root, runId), 'episodes', id);
    requestPath = join(dir, 'request.md');
    const epObj = {
      id, plugin, role, kind, point, workstream_id: workstream, status: 'pending',
      request_path: requestPath, expected_artifacts: expectedArtifacts,
      verification: { checker_episode_required: role === 'maker', checker_plugin: 'deep-review', review_point: point, proof_required: expectedArtifacts },
    };
    if (targetMaker && typeof targetMaker === 'string' && targetMaker.length) epObj.target_maker = targetMaker;
    loop.episodes.push(epObj);
    loop.current_episode = id;
    if (role === 'maker') loop.comprehension.episodes_total = (loop.comprehension.episodes_total || 0) + 1;
    if (workstream) {
      // preCheck guarantees the workstream exists when non-null (Codex impl r14/r15) — bind episode to it.
      loop.workstreams.find(w => w.id === workstream).episodes.push(id);
    }
  }, (loop) => {
    const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
    // Codex impl r15 🟡: reject a non-null workstream that does not exist — otherwise a maker bound to a phantom
    // workstream becomes unreviewable (dispatchReview rightly rejects WORKSTREAM_NOT_FOUND at review time).
    if (workstream && !loop.workstreams.find(w => w.id === workstream)) throw new Error(`WORKSTREAM_NOT_FOUND: ${workstream}`);
  });
  // Assert containment before FS writes
  const base = resolve(runDir(root, runId), 'episodes');
  const full = resolve(dir);
  if (full !== base && !full.startsWith(base + sep)) throw new Error('EPISODE_PATH_ESCAPE: ' + id);
  mkdirSync(dir, { recursive: true });
  atomicWrite(requestPath, requestSkeleton({ id, plugin, role, kind, point, workstream, expectedArtifacts }));
  return { id, requestPath };
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
    // Codex r3 🔴2: atomic replay guard — already-terminal episode cannot be re-terminaled
    if (TERMINAL.includes(status) && ['approved', 'rejected', 'done'].includes(ep.status)) {
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
  });
}
