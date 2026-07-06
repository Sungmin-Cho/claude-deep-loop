#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { error } from './lib/log.mjs';
import { initRun, buildInitialLoop } from './lib/initrun.mjs';
import { detectPlugins } from './lib/detect.mjs';
import { matchRecipe } from './lib/recipes.mjs';
import { json } from './lib/log.mjs';
import { validate as validateLoop } from './lib/schema.mjs';
import { readState, writeState, patch as patchState, pauseRun, runDir, findRoot } from './lib/state.mjs';
import { leaseCheck, acquireLease, releaseLease } from './lib/lease.mjs';
import { newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal } from './lib/workspace.mjs';
import { newEpisode, recordEpisode, abandonEpisode } from './lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from './lib/review.mjs';
import { nextAction } from './lib/next-action.mjs';
import { emitHandoff } from './lib/handoff.mjs';
import { respawn, respawnGate, resolveSpawnMode, isHeadlessInvocation } from './lib/respawn.mjs';
import { headlessSpawn, visibleSpawn } from './lib/spawn-driver.mjs';
import { resolveAdapter, guardTierProtocol, loadProtocol } from './lib/adapters.mjs';
import { recordCost, checkBudget } from './lib/budget.mjs';
import { computeDebt, ack as ackComprehension } from './lib/comprehension.mjs';
import { checkBreaker, resetBreaker } from './lib/breaker.mjs';
import { offerDesktop, confirmDesktop, declineDesktop, resetDesktop } from './lib/spawn-optin.mjs';
import { setSessionProfile } from './lib/session-profile.mjs';
import { defaultDesktopProbe } from './lib/desktop-target.mjs';
import { finishRun } from './lib/finish.mjs';
import { detectAndPersist } from './lib/detect-terminal.mjs';
import { recoverRun } from './lib/recover.mjs';

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const body = argv[i].slice(2);
    // Support the `--key=value` single-token form (previously silently became a literal key with no
    // value → a flag like `--model=opus` was dropped). Only splits when the '=' is in the SAME token;
    // the space form `--key value` (and values that themselves contain '=') are unaffected.
    const eq = body.indexOf('=');
    if (eq >= 0) { f[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const v = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    f[body] = v;
  }
  return f;
}

function parseNow(f) {
  if (f.now === undefined || f.now === true) return Date.now();
  const s = String(f.now);
  const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(n) ? n : Date.now();
}

function reqStr(f, name) { const v = f[name]; return (typeof v === 'string' && v.length) ? v : null; }   // 누락 시 null (핸들러가 exit 2 결정)
function optInt(f, name) {   // 미지정 → 0; 지정 시 비음정수 문자열만 허용, 아니면 null(핸들러가 exit 1)
  const v = f[name];
  if (v === undefined) return 0;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  return Number(v);
}

function rootOf(f) { return f['project-root'] || findRoot(process.cwd()); }
function runIdOf(root, f) {
  if (f['run-id']) return f['run-id'];
  const p = join(root, '.deep-loop', 'current');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}
// 변경 명령 펜싱 (spec §9.1) — owner/generation 불일치 시 LEASE_FENCED.
function intArg(f, name) {
  const v = f[name];
  if (typeof v !== 'string' || !/^\d+$/.test(v)) { error('INVALID_' + name.toUpperCase().replace('-', '_') + ': must be a positive integer'); process.exit(3); }
  return Number(v);
}
function strArg(f, name) {
  const v = f[name];
  if (typeof v !== 'string' || v.length === 0) { error('INVALID_' + name.toUpperCase().replace(/-/g, '_') + ': must be a non-empty string'); process.exit(3); }
  return v;
}
function requireLease(root, runId, f, intent = 'business') {
  strArg(f, 'owner');
  const generation = intArg(f, 'generation');
  const { data } = readState(root, runId);
  const r = leaseCheck(data, { owner: f.owner, generation, intent });
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
    const root = rootOf(f);
    const runId = runIdOf(root, f);
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
    if (f.model === true || f.effort === true) { error('USAGE: --model/--effort require a value'); return 2; }
    const model = f.model !== undefined ? String(f.model) : null;
    const effort = f.effort !== undefined ? String(f.effort) : null;
    try {
      const { runId } = initRun(root, { goal: f.goal, protocol: f.protocol, recipe: f.recipe, detected: detectPlugins(root), review: f.review ? JSON.parse(f.review) : undefined, model, effort });
      json({ run_id: runId }); return 0;
    } catch (e) {
      error(String(e?.message || e)); return 1;   // INVALID_MODEL / INVALID_EFFORT → exit 1 (fail-closed)
    }
  },
  'next-action': async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json(nextAction(data, { now: parseNow(f) })); return 0; },
  tick: async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json({ mode: f.mode || 'advance', ...nextAction(data, { now: parseNow(f) }) }); return 0; },
  lease: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readState(root, runId); json(leaseCheck(data, { owner: strArg(f, 'owner'), generation: intArg(f, 'generation') })); return 0; }
    if (verb === 'acquire') { json(acquireLease(root, runId, { owner: strArg(f, 'owner'), expectGeneration: intArg(f, f['expect-generation'] !== undefined ? 'expect-generation' : 'generation') })); return 0; }
    if (verb === 'release') { json(releaseLease(root, runId, { owner: strArg(f, 'owner'), generation: intArg(f, 'generation') })); return 0; }
    error(`unknown lease verb: ${verb}`); return 2;
  },
  workstream: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    if (verb === 'new') {
      const title = reqStr(f, 'title'); if (!title) { error('MISSING_TITLE'); return 2; }
      const branch = reqStr(f, 'branch'); if (!branch) { error('MISSING_BRANCH'); return 2; }
      const worktree = reqStr(f, 'worktree'); if (!worktree) { error('MISSING_WORKTREE'); return 2; }
      let dependsOn = [];
      if (f['depends-on'] !== undefined) {
        let parsed;
        try { parsed = JSON.parse(f['depends-on']); } catch { error('INVALID_DEPENDS_ON'); return 1; }
        if (!Array.isArray(parsed) || parsed.some(d => typeof d !== 'string' || d.length === 0)) { error('INVALID_DEPENDS_ON'); return 1; }
        dependsOn = parsed;
      }
      const r = newWorkstream(root, runId, { title, branch, worktree, dependsOn, fence }); json(r); return 0;
    }
    if (verb === 'set') {
      const id = reqStr(f, 'id'); if (!id) { error('MISSING_ID'); return 2; }
      const status = reqStr(f, 'status'); if (!status) { error('MISSING_STATUS'); return 2; }
      setWorkstreamStatus(root, runId, id, status, { fence }); json({ ok: true }); return 0;
    }
    // 터미널(ready/merged/abandoned)은 proof 필수 — 커널 파생 (Codex r1 🔴6: CLI 경계로 노출)
    if (verb === 'terminal') {
      const id = reqStr(f, 'id'); if (!id) { error('MISSING_ID'); return 2; }
      const status = reqStr(f, 'status'); if (!status) { error('MISSING_STATUS'); return 2; }
      recordWorkstreamTerminal(root, runId, id, { status, proof: f.proof ? JSON.parse(f.proof) : {}, fence }); json({ ok: true }); return 0;
    }
    error(`unknown workstream verb: ${verb}`); return 2;
  },
  episode: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    if (verb === 'new') {
      const plugin = reqStr(f, 'plugin'); if (!plugin) { error('MISSING_PLUGIN'); return 2; }
      const role = reqStr(f, 'role'); if (!role) { error('MISSING_ROLE'); return 2; }
      const kind = reqStr(f, 'kind'); if (!kind) { error('MISSING_KIND'); return 2; }
      const point = reqStr(f, 'point'); if (!point) { error('MISSING_POINT'); return 2; }
      const r = newEpisode(root, runId, { plugin, role, kind, point, workstream: f.workstream, expectedArtifacts: f.artifacts ? JSON.parse(f.artifacts) : [], fence }); json({ id: r.id, request_path: r.requestPath }); return 0;
    }
    if (verb === 'record') {
      const id = reqStr(f, 'id'); if (!id) { error('MISSING_ID'); return 2; }
      const status = reqStr(f, 'status'); if (!status) { error('MISSING_STATUS'); return 2; }
      if (status === 'approved' || status === 'rejected') { error(`EPISODE_TERMINAL_VIA_REVIEW: approved/rejected come only from 'review record'`); return 1; }
      if (status === 'abandoned') { error(`EPISODE_ABANDON_VIA_VERB: use 'episode abandon --confirm'`); return 1; }
      recordEpisode(root, runId, id, { status, artifacts: f.artifacts ? JSON.parse(f.artifacts) : [], proof: f.proof ? JSON.parse(f.proof) : {}, fence }); json({ ok: true }); return 0;
    }
    if (verb === 'abandon') {
      const id = reqStr(f, 'id'); if (!id) { error('MISSING_ID'); return 2; }
      const reason = reqStr(f, 'reason'); if (!reason) { error('MISSING_REASON'); return 2; }
      // Mirror the recover/breaker-reset human-gate: missing --confirm is a usage error (exit 2), not an
      // uncaught CONFIRM_REQUIRED stack trace (exit 1). Keep passing confirm:true into the lib (defense in depth).
      if (f.confirm !== true && f.confirm !== 'true') { error('CONFIRM_REQUIRED: pass --confirm (human-only)'); return 2; }
      try {
        abandonEpisode(root, runId, id, { reason, confirm: true, fence }); json({ ok: true, status: 'abandoned' }); return 0;
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.startsWith('LEASE_FENCED')) { error(msg); return 3; }
        error(msg); return 1;   // EPISODE_ALREADY_TERMINAL / EPISODE_NOT_FOUND / EPISODE_INPUT_INVALID → exit 1
      }
    }
    error(`unknown episode verb: ${verb}`); return 2;
  },
  review: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    if (verb === 'dispatch') {
      const point = reqStr(f, 'point'); if (!point) { error('MISSING_POINT'); return 2; }
      const workstream = reqStr(f, 'workstream'); if (!workstream) { error('MISSING_WORKSTREAM'); return 2; }
      json(dispatchReview(root, runId, { point, workstreamId: workstream, detected: detectPlugins(root), fence })); return 0;
    }
    // verdict 기록 → checker 터미널 파생 + breaker/comprehension/review_points (Codex r1 🔴6: CLI 경계로 노출)
    if (verb === 'record') {
      const episode = reqStr(f, 'episode'); if (!episode) { error('MISSING_EPISODE'); return 2; }
      const workstream = reqStr(f, 'workstream'); if (!workstream) { error('MISSING_WORKSTREAM'); return 2; }
      const point = reqStr(f, 'point'); if (!point) { error('MISSING_POINT'); return 2; }
      const verdict = reqStr(f, 'verdict'); if (!verdict) { error('MISSING_VERDICT'); return 2; }
      // --report (required for a passing verdict) / --findings (optional aux). The CLI does NOT pre-gate by
      // verdict — the lib decides (CLI-bypass safe); a missing report on APPROVE/CONCERN surfaces REVIEW_NO_EVIDENCE.
      const report = f.report && f.report !== true ? String(f.report) : undefined;
      const findings = f.findings && f.findings !== true ? String(f.findings) : undefined;
      try { json(recordReviewOutcome(root, runId, { episodeId: episode, workstreamId: workstream, point, verdict, source: f.source || 'deep-review-approve', proof: { report, findings }, fence })); return 0; }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }   // REVIEW_NO_EVIDENCE → exit 1
    }
    error(`unknown review verb: ${verb}`); return 2;
  },
  handoff: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    const data = requireLease(root, runId, f, 'lease');
    const expect = { owner: f.owner, generation: intArg(f, 'generation') };
    if (verb === 'emit') { const h = f.headless === true || f.headless === 'true' || data.autonomy?.spawn_style === 'headless' || isHeadlessInvocation(process.env); json(emitHandoff(root, runId, { reason: f.reason, trigger: f.trigger || f.reason || 'milestone', headless: h, resumePolicy: h ? 'headless' : 'visible', expect })); return 0; }
    error(`unknown handoff verb: ${verb}`); return 2;
  },
  // respawn --owner <id> --generation <n> [--attended] [--headless]
  // Resolves the spawn mode FIRST (R2-plan), then injects the matching spawnFn (headless→headlessSpawn measured,
  // visible launcher→visibleSpawn best-effort) — a headless entry must NEVER run through visibleSpawn. The fence
  // (--owner/--generation) is required (exit 3) and re-checked in-lock by respawn's appendAnchored preChecks (R11-II).
  respawn: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    const { data } = readState(root, runId);
    if (f['dry-run']) { json(respawnGate(data)); return 0; }
    // Require + fence --owner/--generation (exit 3). intent 'lease' so a releasing handoff lease is not rejected.
    requireLease(root, runId, f, 'lease');
    const headless = f.headless === true || f.headless === 'true';
    const attended = f.attended === true || f.attended === 'true';
    const mode = resolveSpawnMode(data, { headless, attended, env: process.env });
    const spawnFn = mode === 'headless' ? headlessSpawn : visibleSpawn;
    const lease = data.session_chain?.lease || {};
    const childRunId = lease.handoff_child_run_id;
    const key = lease.handoff_idempotency_key;
    const cs = (data.session_chain?.sessions || []).find(s => s.run_id === childRunId);
    const handoffRel = cs && cs.handoff_rel;
    const pollLease = () => readState(root, runId).data.session_chain.lease;
    try {
      const r = respawn(root, runId, { childRunId, key, handoffRel, headless, attended, now: parseNow(f), spawnFn, pollLease, env: process.env });
      json({ mode, ...r });
      return r.ok ? 0 : (r.outcome === 'fenced' ? 3 : 0);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.startsWith('LEASE_FENCED') || msg.startsWith('RESPAWN_FENCED')) { error(msg); return 3; }
      error(msg); return 1;
    }
  },
  state: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'get') {
      if (runId == null) { json(null); return 0; }   // no pointer at all (first entry) → clean null
      const explicit = f['run-id'] != null;           // explicit --run-id vs implicit .deep-loop/current
      let data;
      try { ({ data } = readState(root, runId)); }
      catch (e) {
        // null ONLY for: implicit current pointer AND the run dir itself is absent (genuine stale pointer).
        if (e && e.code === 'ENOENT' && !explicit && !existsSync(runDir(root, runId))) { json(null); return 0; }
        // run dir present but loop.json gone = partial state loss → fail closed (don't mask as "no run").
        if (e && e.code === 'ENOENT' && existsSync(runDir(root, runId))) {
          error(`STATE_MISSING: ${runId} loop.json absent but run dir exists`); return 1;
        }
        // explicit --run-id miss / STATE_TAMPERED / bad JSON / EACCES / RUN_ID_INVALID / other → surface.
        error(String(e && e.message || e)); return 1;
      }
      if (f.field === undefined || f.field === true) { json(data); return 0; }
      const val = String(f.field).split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
      json(val === undefined ? null : val); return 0;
    }
    if (verb === 'patch') {
      if (runId == null) { error('MISSING_RUN_ID'); return 2; }   // mutating with no run = usage error (before fence)
      requireLease(root, runId, f);   // --owner/--generation 누락·불일치 → exit 3 (fence)
      const field = reqStr(f, 'field'); if (!field) { error('MISSING_FIELD'); return 2; }       // Codex r1 sf-6: 비-fence 누락 → exit 2
      const rawVal = reqStr(f, 'value'); if (rawVal === null) { error('MISSING_VALUE'); return 2; }
      let value; try { value = JSON.parse(rawVal); } catch { error('INVALID_VALUE: must be JSON'); return 1; }   // 무효 값 → exit 1
      try { patchState(root, runId, field, value, { fence: { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' } }); }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
      json({ ok: true }); return 0;
    }
    error(`unknown state verb: ${verb}`); return 2;
  },
  // pause --owner <id> --generation <n> --reason <r> [--mode preserve|rollback]
  // Two-mode safety pause: RUN_PAUSED blocks business writes; humans resume/recover manually.
  // Exit 3 = LEASE_FENCED (wrong owner/generation); 2 = missing required arg; 0 = success.
  pause: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    const owner = reqStr(f, 'owner'); if (!owner) { error('MISSING_OWNER'); return 2; }
    const reason = reqStr(f, 'reason'); if (!reason) { error('MISSING_REASON'); return 2; }
    const generation = intArg(f, 'generation');   // exits 3 on invalid/missing (consistent with other handlers)
    const mode = (f.mode === 'rollback') ? 'rollback' : 'preserve';
    try {
      pauseRun(root, runId, { reason, mode, expect: { owner, generation }, now: Date.now() });
      json({ ok: true, status: 'paused' }); return 0;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.startsWith('LEASE_FENCED')) { error(msg); return 3; }
      error(msg); return 1;
    }
  },
  // recover --owner <id> --generation <n> --confirm
  // Human-approved escape hatch (mirrors breaker reset --confirm): unstick-for-resume, NOT terminate.
  // Clears stale handoff state so a fresh acquireLease (Task 8) can take over and unpause.
  // Exit 3 = LEASE_FENCED (wrong owner/generation); 2 = missing --confirm or usage; 0 = success.
  recover: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    if (f.confirm !== true && f.confirm !== 'true') { error('CONFIRM_REQUIRED: pass --confirm (human-only)'); return 2; }
    const owner = reqStr(f, 'owner'); if (!owner) { error('MISSING_OWNER'); return 2; }
    const generation = intArg(f, 'generation');   // exits 3 on invalid/missing
    try {
      recoverRun(root, runId, { expect: { owner, generation }, confirm: true, now: parseNow(f) });
      json({ ok: true, status: 'paused', pause_reason: 'recovered:awaiting-resume' }); return 0;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.startsWith('LEASE_FENCED')) { error(msg); return 3; }
      if (msg.startsWith('NOT_RECOVERABLE') || msg.startsWith('CONFIRM_REQUIRED')) { error(msg); return 2; }
      error(msg); return 1;
    }
  },
  adapter: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest);
    if (verb !== 'resolve') { error(`unknown adapter verb: ${verb}`); return 2; }
    const protocol = reqStr(f, 'protocol'); if (!protocol) { error('MISSING_PROTOCOL'); return 2; }
    let ad, p; try { ad = resolveAdapter(protocol); p = loadProtocol(protocol); } catch { error(`UNKNOWN_PROTOCOL: ${protocol}`); return 2; }
    const task = reqStr(f, 'task') || '';
    const ref = { task };
    const fillTask = (t) => String(t || '').replace(/<task>/g, task);
    let dispatch = ad.dispatch(ref);
    const awaitD = ad.awaitResult(ref);
    const read = { path: p.read.receipt_path_template ? fillTask(p.read.receipt_path_template) : null, producer: p.read.producer, artifact_kind: p.read.artifact_kind };
    // guard 는 implementer_verb 기준 (tier×protocol 모순). Codex r7 sf-1: read-only 가 implementer 를 막을 때,
    // implementer_verb 가 'then'(superpowers)이면 planning(dispatch.skill=writing-plans)은 살리고 `then`(subagent-driven-development)만 strip,
    // 'dispatch'(deep-work/standalone)면 dispatch 자체가 implementer 라 전체 차단(guard.ok=false).
    const implGuard = f.tier && f.tier !== true ? guardTierProtocol(f.tier, protocol, p.implementer_verb) : { ok: true, reason: 'no-tier' };
    let guard = implGuard;
    if (!implGuard.ok && p.implementer_verb === 'then') {
      dispatch = { ...dispatch, then: null };                                  // planning-only: writing-plans 실행, then skip
      guard = { ok: true, reason: 'planning-only-readonly', planning_only: true };
    }
    const sel = f.verb && f.verb !== true ? String(f.verb) : null;
    if (sel) {
      const map = { dispatch, await: awaitD, read };
      if (!(sel in map)) { error(`UNKNOWN_VERB: ${sel}`); return 2; }
      json({ protocol, selected: sel, descriptor: map[sel], guard }); return 0;
    }
    json({ protocol, dispatch, await: awaitD, read, checker_via: 'review dispatch --point <p> --workstream <ws> (kernel derives checker episode + descriptor)', guard }); return 0;
  },
  budget: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readState(root, runId); json(checkBudget(data, { now: parseNow(f) })); return 0; }
    if (verb === 'record') {
      requireLease(root, runId, f);
      // Codex r4 sf-4: parseFlags 는 값 없는 플래그를 true 로 둔다 → Number(true)=1 오기록 방지.
      // 미지정 → 0, 지정 시 비음정수 문자열만 허용(true/음수/NaN/Infinity 거부).
      const turns = optInt(f, 'turns'); const tokens = optInt(f, 'tokens');
      if (turns === null || tokens === null) { error('INVALID_COST: --turns/--tokens must be non-negative integers'); return 1; }
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      try { recordCost(root, runId, { turns, tokens, fence }); }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
      const { data } = readState(root, runId);
      json({ ok: true, spent: data.budget.spent, tokens_spent: data.budget.tokens_spent }); return 0;
    }
    error(`unknown budget verb: ${verb}`); return 2;
  },
  comprehension: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'status') { const { data } = readState(root, runId); json(computeDebt(data)); return 0; }
    if (verb === 'ack') {
      requireLease(root, runId, f);   // fence 인자 → exit 3
      const episode = reqStr(f, 'episode'); if (!episode) { error('MISSING_EPISODE'); return 2; }   // Codex r1 sf-6
      if (f.actor === true) { error('USAGE: --actor requires a value (human|agent)'); return 2; }   // value-less 거부
      const actor = f.actor !== undefined ? String(f.actor) : 'agent';
      if (!['human', 'agent'].includes(actor)) { error('INVALID_ACTOR: --actor must be human|agent'); return 2; }
      const confirm = f.confirm === true || f.confirm === 'true';
      // Fast-fail UX + defense-in-depth. The authoritative guard is in ack() itself (CLI-bypass safe).
      if (actor === 'human' && !confirm) { error('CONFIRM_REQUIRED: human ack requires --confirm (human-only)'); return 2; }
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      let r;
      try { r = ackComprehension(root, runId, episode, { actor, confirm, env: process.env, fence }); }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }   // EPISODE_NOT_FOUND → exit 1
      if (r && r.ok === false && r.rejected) {
        // headless-human fail-closed (the ack-rejected event is already appended). Surface as usage error.
        error(`ACK_REJECTED: ${r.reason}`);
        const { data } = readState(root, runId); json({ ok: false, ...computeDebt(data) }); return 2;
      }
      const { data } = readState(root, runId); json({ ok: true, ...computeDebt(data) }); return 0;
    }
    error(`unknown comprehension verb: ${verb}`); return 2;
  },
  breaker: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readState(root, runId); json(checkBreaker(data)); return 0; }
    if (verb === 'reset') {
      if (f.confirm !== true && f.confirm !== 'true') { error('BREAKER_RESET_REQUIRES_CONFIRM: pass --confirm (human-only)'); return 2; }
      requireLease(root, runId, f, 'breaker-reset');   // Codex r2 critical-1: fence 필수; breaker-reset exempt from RUN_PAUSED gate
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'breaker-reset' };
      try { json(resetBreaker(root, runId, { fence })); return 0; }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
    }
    error(`unknown breaker verb: ${verb}`); return 2;
  },
  // spawn-style offer-desktop|confirm-desktop|decline-desktop|reset-desktop --owner <id> --generation <n> [--nonce <n>]
  //           | probe-desktop
  // Durable, nonce-bound desktop opt-in (Task 7; round-6 review parts a/b/c). Fence-fenced like every
  // other mutating subcommand: requireLease is a fast outer pre-check (exit 3 on missing/invalid/
  // mismatched owner-generation); the lib functions re-check the SAME fence in-lock (authoritative — see
  // spawn-optin.mjs). `probe-desktop` is READ-ONLY (no state mutation, no event appended), so it needs no
  // fence/owner/generation/run and is dispatched BEFORE requireLease; the skill uses it to gate whether
  // to even OFFER the opt-in (round-6 part b), and a human/operator can run it standalone with no active
  // run. `reset-desktop` is the other exception (round-7 review Finding 1): it is a HUMAN RECOVERY
  // operation that must work while the run is paused with a releasing lease (the exact state a
  // desktop-unavailable respawn leaves behind), so it skips requireLease's business-intent leaseCheck()
  // and relies on resetDesktop's own bespoke in-lock fence instead (owner/generation only — same LEASE_
  // FENCED exit-3 contract, no RUN_PAUSED/releasing gating). Exit codes: 3 = LEASE_FENCED (fence, incl.
  // missing/invalid --owner/--generation — N/A for probe-desktop), 1 = {ok:false} rejection (NONCE_INVALID/
  // NONCE_EXPIRED/SOURCE_INVALID/PLATFORM_UNSUPPORTED/HANDLER_UNVERIFIED) or any other thrown error, 2 =
  // unknown verb.
  'spawn-style': async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest);
    if (verb === 'probe-desktop') { json(defaultDesktopProbe({ platform: process.platform })); return 0; }
    const root = rootOf(f); const runId = runIdOf(root, f);
    // reset-desktop is a HUMAN RECOVERY operation (round-7 review Finding 1) — it must work in the EXACT
    // stuck state a desktop-unavailable respawn leaves behind: status='paused', lease.state='releasing'
    // (see respawn.mjs preservePause). The shared business-intent requireLease() precheck below rejects
    // both of those, so — mirroring how the `recover` subcommand above ALSO bypasses requireLease and
    // lets its lib function's own bespoke fence be authoritative — reset-desktop skips it too. Shape is
    // still validated fast (missing/non-string --owner → exit 3), matching every other spawn-style verb's
    // exit-3 usage contract; the real fence check happens inside resetDesktop (spawn-optin.mjs), in-lock.
    if (verb === 'reset-desktop') strArg(f, 'owner');
    else requireLease(root, runId, f);
    const expect = { owner: f.owner, generation: intArg(f, 'generation') };
    const now = parseNow(f);
    const nonce = (f.nonce !== undefined && f.nonce !== true) ? String(f.nonce) : undefined;
    if (verb === 'offer-desktop') {
      let ttlSec; if (f['ttl-sec'] !== undefined) { ttlSec = optInt(f, 'ttl-sec'); if (ttlSec === null) { error('INVALID_TTL_SEC'); return 1; } }
      try { const r = offerDesktop(root, runId, { expect, now, nonce, ...(ttlSec != null ? { ttlSec } : {}) }); json(r); return r.ok ? 0 : 1; }
      catch (e) { const msg = String(e?.message || e); if (msg.startsWith('LEASE_FENCED')) { error(msg); return 3; } error(msg); return 1; }
    }
    if (verb === 'confirm-desktop') {
      // desktopProbe not injected here — defaults to defaultDesktopProbe (real host probe on process.platform),
      // matching the (uninjected) `platform` default too. Round-6 part (a): a failing probe now returns
      // {ok:false, reason:'HANDLER_UNVERIFIED'} and persists NOTHING.
      try { const r = confirmDesktop(root, runId, { expect, now, nonce }); json(r); return r.ok ? 0 : 1; }
      catch (e) { const msg = String(e?.message || e); if (msg.startsWith('LEASE_FENCED')) { error(msg); return 3; } error(msg); return 1; }
    }
    if (verb === 'decline-desktop') {
      try { json(declineDesktop(root, runId, { expect, now })); return 0; }
      catch (e) { const msg = String(e?.message || e); if (msg.startsWith('LEASE_FENCED')) { error(msg); return 3; } error(msg); return 1; }
    }
    if (verb === 'reset-desktop') {
      try { const r = resetDesktop(root, runId, { expect, now }); json(r); return r.ok ? 0 : 1; }
      catch (e) { const msg = String(e?.message || e); if (msg.startsWith('LEASE_FENCED')) { error(msg); return 3; } error(msg); return 1; }
    }
    error(`unknown spawn-style verb: ${verb}`); return 2;
  },
  // session-profile set --model <m> --effort <e> --owner <id> --generation <n>
  // Refresh durable autonomy.session_model/effort (WS1). intent:'lease' (releasing-safe, like respawn/
  // detect-terminal) so an attended session can refresh while a PreCompact handoff is in-flight. Exit
  // codes: 3 = LEASE_FENCED (incl. missing/invalid --owner/--generation), 1 = invalid model/effort, 2 = usage.
  'session-profile': async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb !== 'set') { error(`unknown session-profile verb: ${verb}`); return 2; }
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    // A value-less --model/--effort (parseFlags → true) is a malformed invocation, NOT an omission —
    // reject as usage (exit 2) so it can never silently drop the field while writing the other.
    if (f.model === true || f.effort === true) { error('USAGE: --model/--effort require a value'); return 2; }
    requireLease(root, runId, f, 'lease');   // releasing-safe outer fence (exit 3)
    const expect = { owner: f.owner, generation: intArg(f, 'generation') };
    const model = f.model !== undefined ? String(f.model) : undefined;
    const effort = f.effort !== undefined ? String(f.effort) : undefined;
    if (model === undefined && effort === undefined) { error('NOTHING_TO_SET'); return 2; }
    try {
      const r = setSessionProfile(root, runId, { model, effort, expect, now: parseNow(f) });
      json(r); return 0;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.startsWith('LEASE_FENCED')) { error(msg); return 3; }
      error(msg); return 1;
    }
  },
  'detect-terminal': async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    // intent:'lease' so a releasing lease is not rejected (releasing-safe R11-HH)
    requireLease(root, runId, f, 'lease');
    const now = new Date(parseNow(f)).toISOString();
    try {
      const d = detectAndPersist(root, runId, { owner: f.owner, generation: intArg(f, 'generation'), now });
      json(d); return 0;
    } catch (e) {
      if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; }
      error(e.message); return 1;
    }
  },
  finish: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);   // fence 인자 → exit 3
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    const status = reqStr(f, 'status'); if (!status) { error('MISSING_STATUS'); return 2; }   // Codex r1 sf-6
    const reportRel = f.report && f.report !== true ? String(f.report) : undefined;
    if (reportRel && (reportRel.startsWith('/') || reportRel.split('/').includes('..'))) { error('FINISH_REPORT_PATH_UNSAFE'); return 1; }
    let proof; try { proof = f.proof ? JSON.parse(f.proof) : {}; } catch { error('INVALID_PROOF: must be JSON'); return 1; }   // 무효 값 → exit 1
    try { const r = finishRun(root, runId, { status, reportRel, proof, fence, now: parseNow(f) }); json(r); return 0; }
    catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }   // FINISH_STATUS_INVALID/PROOF_UNMET → exit 1
  },
};

const fn = handlers[sub];
if (!fn) { error(`unknown subcommand: ${sub ?? '<none>'}`); process.exit(2); }
process.exit(await fn(rest));
