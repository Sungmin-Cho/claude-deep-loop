#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { error } from './lib/log.mjs';
import { initRun, buildInitialLoop } from './lib/initrun.mjs';
import { detectPlugins } from './lib/detect.mjs';
import { matchRecipe } from './lib/recipes.mjs';
import { json } from './lib/log.mjs';
import { validate as validateLoop } from './lib/schema.mjs';
import { readState, writeState } from './lib/state.mjs';
import { leaseCheck, acquireLease, releaseLease } from './lib/lease.mjs';
import { newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal } from './lib/workspace.mjs';
import { newEpisode, recordEpisode } from './lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from './lib/review.mjs';
import { nextAction } from './lib/next-action.mjs';
import { emitHandoff } from './lib/handoff.mjs';
import { respawn, respawnGate } from './lib/respawn.mjs';

function parseFlags(argv) {
  const f = {}; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; f[k] = v; } } return f;
}

function rootOf(f) { return f['project-root'] || process.cwd(); }
function runIdOf(root, f) {
  if (f['run-id']) return f['run-id'];
  const p = join(root, '.deep-loop', 'current');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}
// 변경 명령 펜싱 (spec §9.1) — owner/generation 불일치 시 LEASE_FENCED.
function requireLease(root, runId, f, intent = 'business') {
  const { data } = readState(root, runId);
  const r = leaseCheck(data, { owner: f.owner, generation: Number(f.generation), intent });
  if (!r.ok) { error(`LEASE_FENCED: ${r.reason}`); process.exit(3); }
  return data;
}

const [, , sub, ...rest] = process.argv;

// validate: 비공허 검증 (Codex impl 🟡4)
// 1) 스키마+빌더 self-test: buildInitialLoop 산출물이 항상 검증 통과해야 함 (regression 게이트)
// 2) 현재/지정 run이 있으면 readState(해시 검증 발화) + schema.validate
const handlers = {
  validate: async (a) => {
    const f = parseFlags(a);
    const errors = [];
    const sample = buildInitialLoop({ goal: 'self-test', protocol: 'standalone', recipe: { id: 'r', name: 'r', reason: '' }, runId: 'SELFTEST00000000000000000T', now: new Date() });
    const sv = validateLoop(sample);
    if (!sv.ok) errors.push(`builder self-test: ${sv.errors.join('; ')}`);
    const root = f['project-root'] || process.cwd();
    const currentPath = join(root, '.deep-loop', 'current');
    const runId = f['run-id'] || (existsSync(currentPath) ? readFileSync(currentPath, 'utf8').trim() : null);
    if (runId) {
      try {
        const { data } = readState(root, runId);   // 해시 anchor 검증 발화
        const rv = validateLoop(data);
        if (!rv.ok) errors.push(`run ${runId}: ${rv.errors.join('; ')}`);
      } catch (e) { errors.push(`run ${runId}: ${e.message}`); }
    }
    if (errors.length) { error(`validate failed:\n - ${errors.join('\n - ')}`); return 1; }
    process.stdout.write(`ok${runId ? ` (run ${runId})` : ' (schema+builder self-test)'}\n`);
    return 0;
  },
  'detect-plugins': async (a) => { const f = parseFlags(a); json(detectPlugins(rootOf(f))); return 0; },
  'recipe-match': async (a) => { const f = parseFlags(a); const root = rootOf(f); json(matchRecipe(f.goal || '', detectPlugins(root))); return 0; },
  'init-run': async (a) => {
    const f = parseFlags(a);
    const root = rootOf(f);
    const { runId } = initRun(root, { goal: f.goal, protocol: f.protocol, recipe: f.recipe, detected: detectPlugins(root), review: f.review ? JSON.parse(f.review) : undefined });
    json({ run_id: runId }); return 0;
  },
  'next-action': async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json(nextAction(data)); return 0; },
  tick: async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json({ mode: f.mode || 'advance', ...nextAction(data) }); return 0; },
  lease: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readState(root, runId); json(leaseCheck(data, { owner: f.owner, generation: Number(f.generation) })); return 0; }
    if (verb === 'acquire') { json(acquireLease(root, runId, { owner: f.owner, expectGeneration: Number(f['expect-generation'] ?? f.generation) })); return 0; }
    if (verb === 'release') { json(releaseLease(root, runId, { owner: f.owner, generation: Number(f.generation) })); return 0; }
    error(`unknown lease verb: ${verb}`); return 2;
  },
  workstream: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    if (verb === 'new') { const r = newWorkstream(root, runId, { title: f.title, branch: f.branch, worktree: f.worktree, dependsOn: f['depends-on'] ? JSON.parse(f['depends-on']) : [] }); json(r); return 0; }
    if (verb === 'set') { setWorkstreamStatus(root, runId, f.id, f.status); json({ ok: true }); return 0; }
    // 터미널(ready/merged/abandoned)은 proof 필수 — 커널 파생 (Codex r1 🔴6: CLI 경계로 노출)
    if (verb === 'terminal') { recordWorkstreamTerminal(root, runId, f.id, { status: f.status, proof: f.proof ? JSON.parse(f.proof) : {} }); json({ ok: true }); return 0; }
    error(`unknown workstream verb: ${verb}`); return 2;
  },
  episode: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    if (verb === 'new') { const r = newEpisode(root, runId, { plugin: f.plugin, role: f.role, kind: f.kind, point: f.point, workstream: f.workstream, expectedArtifacts: f.artifacts ? JSON.parse(f.artifacts) : [] }); json({ id: r.id, request_path: r.requestPath }); return 0; }
    if (verb === 'record') { recordEpisode(root, runId, f.id, { status: f.status, artifacts: f.artifacts ? JSON.parse(f.artifacts) : [], proof: f.proof ? JSON.parse(f.proof) : {} }); json({ ok: true }); return 0; }
    error(`unknown episode verb: ${verb}`); return 2;
  },
  review: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    if (verb === 'dispatch') { json(dispatchReview(root, runId, { point: f.point, workstreamId: f.workstream, detected: detectPlugins(root) })); return 0; }
    // verdict 기록 → checker 터미널 파생 + breaker/comprehension/review_points (Codex r1 🔴6: CLI 경계로 노출)
    if (verb === 'record') { json(recordReviewOutcome(root, runId, { episodeId: f.episode, workstreamId: f.workstream, point: f.point, verdict: f.verdict, source: f.source || 'deep-review-approve' })); return 0; }
    error(`unknown review verb: ${verb}`); return 2;
  },
  handoff: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f, 'lease');
    if (verb === 'emit') { json(emitHandoff(root, runId, { reason: f.reason, trigger: f.trigger || f.reason || 'milestone', headless: !!f.headless })); return 0; }
    error(`unknown handoff verb: ${verb}`); return 2;
  },
  respawn: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    const { data } = readState(root, runId);
    if (f['dry-run']) { json(respawnGate(data)); return 0; }
    // CLI는 spawnFn 미주입 → 실제 spawn은 드라이버(Plan 3). 게이트/디스크립터만.
    json({ note: 'respawn requires a driver-provided spawnFn; CLI exposes gate via --dry-run', gate: respawnGate(data) }); return 0;
  },
};

const fn = handlers[sub];
if (!fn) { error(`unknown subcommand: ${sub ?? '<none>'}`); process.exit(2); }
process.exit(await fn(rest));
