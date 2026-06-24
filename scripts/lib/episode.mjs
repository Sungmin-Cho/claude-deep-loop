import { mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readState, writeState, withLock, runDir } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { atomicWrite } from './envelope.mjs';

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

export function newEpisode(root, runId, { plugin, role, kind, point, workstream = null, expectedArtifacts = [] }) {
  let id, requestPath;
  appendAnchored(root, runId, { type: 'episode-new', data: { plugin, role, kind, point } }, (loop) => {
    const n = String(loop.episodes.length + 1).padStart(3, '0');
    id = `${n}-${plugin}`;
    const dir = join(runDir(root, runId), 'episodes', id);
    mkdirSync(dir, { recursive: true });
    requestPath = join(dir, 'request.md');
    atomicWrite(requestPath, requestSkeleton({ id, plugin, role, kind, point, workstream, expectedArtifacts }));
    loop.episodes.push({
      id, plugin, role, kind, point, workstream_id: workstream, status: 'pending',
      request_path: requestPath, expected_artifacts: expectedArtifacts,
      verification: { checker_episode_required: role === 'maker', checker_plugin: 'deep-review', review_point: point, proof_required: expectedArtifacts },
    });
    loop.current_episode = id;
    loop.comprehension.episodes_total = (loop.comprehension.episodes_total || 0) + 1;
    if (workstream) {
      const ws = loop.workstreams.find(w => w.id === workstream);
      if (ws) ws.episodes.push(id);
    }
  });
  return { id, requestPath };
}

export function recordEpisode(root, runId, episodeId, { status, artifacts = [], proof = {} }) {
  if (![...NON_TERMINAL, ...TERMINAL].includes(status)) throw new Error(`EPISODE_STATUS_INVALID: ${status}`);
  // Codex r3 🔴5: appendAnchored 의 mutate 가 throw 하면 event 가 이미 append 된 뒤라 event_log_head 앵커가 stale 된다.
  // → 모든 실패 조건(존재 + 터미널 proof)을 appendAnchored **이전에** 검증한다.
  const ep0 = readState(root, runId).data.episodes.find(e => e.id === episodeId);
  if (!ep0) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
  // 터미널은 커널이 proof에서 파생 — 검증 후에만 (spec §4)
  if (TERMINAL.includes(status)) {
    if (status === 'done') {
      const expected = (ep0.expected_artifacts || []);
      const missing = expected.filter(a => !existsSync(isAbsolute(a) ? a : join(root, a)));
      if (expected.length === 0 || missing.length) {
        throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} done requires existing artifacts (missing: ${missing.join(',') || 'none-declared'})`);
      }
    } else if (status === 'approved' && !['APPROVE', 'CONCERN'].includes(proof.verdict)) {
      throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} approved requires proof.verdict=APPROVE|CONCERN (accepted concern)`);
    } else if (status === 'rejected' && proof.verdict !== 'REQUEST_CHANGES') {
      throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} rejected requires proof.verdict=REQUEST_CHANGES`);
    }
  }
  appendAnchored(root, runId, { type: 'episode-record', data: { id: episodeId, status, artifacts } }, (loop) => {
    const ep = loop.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);   // 방어적(이미 위에서 검증됨)
    ep.status = status;
    if (artifacts.length) ep.artifacts = artifacts;
    for (const [k, v] of Object.entries(proof)) if (/^result_[A-Za-z0-9_]+$/.test(k)) ep[k] = v;
  });
}
