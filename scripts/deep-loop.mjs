#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { error } from './lib/log.mjs';
import { initRun, buildInitialLoop } from './lib/initrun.mjs';
import { detectPlugins } from './lib/detect.mjs';
import { matchRecipe, recipesDir, validateRecipesDir } from './lib/recipes.mjs';
import { json } from './lib/log.mjs';
import { validate as validateLoop } from './lib/schema.mjs';
import { readState, writeState, patch as patchState, pauseRun, runDir, findRoot } from './lib/state.mjs';
import { leaseCheck, acquireLease, releaseLease } from './lib/lease.mjs';
import { newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal } from './lib/workspace.mjs';
import { newEpisode, recordEpisode, abandonEpisode } from './lib/episode.mjs';
import { dispatchReview, importReviewOutcome, recordReviewOutcome } from './lib/review.mjs';
import { readBoundedText } from './lib/bounded-input.mjs';
import { nextAction } from './lib/next-action.mjs';
import { emitHandoff } from './lib/handoff.mjs';
import { respawn, respawnGate, resolveSpawnMode } from './lib/respawn.mjs';
import { visibleSpawn } from './lib/spawn-driver.mjs';
import { driveHeadlessRun } from './lib/headless-host.mjs';
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
import { computeInsights, emitInsights, latestInsights, validateLedger } from './lib/insights.mjs';
import { diagnoseProjectRoot, rebindProjectRoot } from './lib/project-root-recovery.mjs';
import {
  approveLauncherExecutable,
  approveRuntimeExecutable,
  diagnoseLauncherExecutable,
  diagnoseRuntimeExecutable,
} from './lib/runtime-executable.mjs';

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

function flagOccurrences(argv, name) {
  const flag = `--${name}`;
  return argv.filter(token => token === flag || token.startsWith(`${flag}=`)).length;
}

// --now 관례(v1.5.0, spec §4): 미지정 → Date.now() 폴백. 지정 시 화이트리스트 — ① 순수 정수(epoch ms)
// ② ISO-8601: date-only(YYYY-MM-DD, UTC 자정 해석) 또는 tz 지정자 필수 datetime(YYYY-MM-DDTHH:mm[:ss[.sss]](Z|±HH:MM)).
// 그 외 전부 INVALID_NOW exit 1 (dispatcher 말미의 좁은 catch가 변환; 불변식 #2: 1 = invalid value).
// Date.parse는 쓰지 않는다 — V8이 '2026-02-31'을 3월로 롤오버하고 tz-less를 호스트 타임존으로 해석하므로
// (impl-r1·r2·r3 리뷰), 캡처 정규식 + 자체 Date.UTC 구성 + 컴포넌트 역검증(롤오버 감지)으로 결정론을 완결한다.
const ISO_NOW = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/;
function parseNow(f) {
  if (f.now === undefined) return Date.now();
  if (f.now === true) throw new Error('INVALID_NOW: --now requires a value (epoch ms or ISO-8601 date)');
  const s = String(f.now);
  const bad = () => new Error(`INVALID_NOW: --now must be epoch ms or an ISO-8601 date (got: ${s})`);
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n > 8.64e15) throw bad();
    return n;
  }
  const m = ISO_NOW.exec(s);
  if (!m) throw bad();
  const [, y, mo, d, h = '00', mi = '00', sec = '00', frac = '', tz = 'Z'] = m;
  const ms = Number((frac + '000').slice(0, 3));
  if (tz !== 'Z') {
    const offH = Number(tz.slice(1, 3)), offM = Number(tz.slice(4, 6));
    if (offH > 23 || offM > 59) throw bad();   // +09:99 같은 범위 밖 오프셋 거부 (impl-r4)
  }
  const offMin = tz === 'Z' ? 0 : (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6)));
  const n = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms) - offMin * 60000;
  // 달력 역검증 — Date.UTC도 2026-02-31을 3월로 롤오버하므로, 입력 오프셋 뷰에서 컴포넌트를 재확인해 거부한다.
  const v = new Date(n + offMin * 60000);
  if (v.getUTCFullYear() !== +y || v.getUTCMonth() !== +mo - 1 || v.getUTCDate() !== +d
    || v.getUTCHours() !== +h || v.getUTCMinutes() !== +mi || v.getUTCSeconds() !== +sec) throw bad();
  if (!Number.isFinite(n) || Math.abs(n) > 8.64e15) throw bad();
  return n;
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
function classifyKernelError(e) {
  const message = String(e?.message || e);
  if (/^(?:LEASE_FENCED|FENCE_REQUIRED|RUNTIME_FENCED|PROJECT_ROOT_FENCED)(?::|$)/.test(message)) {
    return { code: 3, message };
  }
  if (/^(?:INVALID_NOW|INVALID_RUNTIME(?:_STATE)?|PROJECT_ROOT_UNRESOLVABLE)(?::|$)/.test(message)) {
    return { code: 1, message };
  }
  if (/^(?:INVALID_ACTOR|INVALID_GENERATION|INVALID_STORED_ROOT_DIGEST|PROJECT_ROOT_REBIND_NOT_ALLOWED|RUN_ID_INVALID|STATE_INVALID)(?::|$)/.test(message)) {
    return { code: 1, message };
  }
  if (/^(?:RUNTIME_EXECUTABLE_|LAUNCHER_EXECUTABLE_|CODEX_HOME_)(?:[A-Z_]+)(?::|$)/.test(message)) {
    return { code: 1, message };
  }
  return null;
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
    const sample = buildInitialLoop({ runtime: 'claude', goal: 'self-test', protocol: 'standalone', recipe: { id: 'r', name: 'r', reason: '' }, runId: 'SELFTEST00000000000000000T', now: new Date() });
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
    // recipe/ledger 정적 검사는 런타임 라우팅이 실제로 읽는 **플러그인 번들** recipesDir 기준이다
    // (project-root 기준이 아님) — --project-root가 타 프로젝트를 가리켜도 그 프로젝트의 recipes/는
    // 검사 대상이 아니고, 번들 recipe는 root와 무관하게 항상 검증된다.
    const ledgerPath = join(recipesDir, 'hillclimb-ledger.json');
    if (existsSync(ledgerPath)) {
      try { const lv = validateLedger(JSON.parse(readFileSync(ledgerPath, 'utf8'))); if (!lv.ok) errors.push(`ledger: ${lv.errors.join('; ')}`); }
      catch (e) { errors.push(`ledger: ${e.message}`); }
    }
    // recipes fail-closed 검증 (impl-R3 🟡C): 런타임 loadRecipes는 손상 파일을 fail-soft로 skip하므로
    // (라우팅 생존), 손상 자체는 여기 validate(preflight/머지 게이트)가 파일명과 함께 잡는다.
    const rv = validateRecipesDir(recipesDir);
    if (!rv.ok) errors.push(...rv.errors);
    if (errors.length) { error(`validate failed:\n - ${errors.join('\n - ')}`); return 1; }
    process.stdout.write(`ok${runId ? ` (run ${runId})` : ' (schema+builder self-test)'}\n`);
    return 0;
  },
  'detect-plugins': async (a) => { const f = parseFlags(a); json(detectPlugins(rootOf(f))); return 0; },
  'recipe-match': async (a) => {
    const f = parseFlags(a); const root = rootOf(f);
    try { json(matchRecipe(f.goal || '', detectPlugins(root))); return 0; }
    catch (e) { error(String(e?.message || e)); return 1; }   // NO_VALID_RECIPES (degraded bundle) → exit 1, no raw stack
  },
  root: async (a) => {
    const [verb, ...rest] = a;
    const f = parseFlags(rest);
    if (verb !== 'diagnose' && verb !== 'rebind') { error(`unknown root verb: ${verb}`); return 2; }
    const candidateRoot = reqStr(f, 'candidate-project-root');
    if (!candidateRoot) { error('USAGE: --candidate-project-root ROOT is required'); return 2; }
    const runId = reqStr(f, 'run-id');
    if (!runId) { error('USAGE: --run-id RUN_ID is required'); return 2; }

    if (verb === 'diagnose') {
      json(diagnoseProjectRoot(candidateRoot, runId));
      return 0;
    }

    const owner = reqStr(f, 'owner');
    if (!owner) { error('USAGE: --owner OWNER is required'); return 2; }
    if (f.generation === undefined || f.generation === true) {
      error('USAGE: --generation N is required'); return 2;
    }
    if (typeof f.generation !== 'string' || !/^\d+$/.test(f.generation)
      || !Number.isSafeInteger(Number(f.generation))) {
      throw new Error('INVALID_GENERATION: must be a non-negative safe integer');
    }
    const actor = reqStr(f, 'actor');
    if (!actor) { error('USAGE: --actor human is required'); return 2; }
    if (f.confirm !== true && f.confirm !== 'true') {
      error('CONFIRM_REQUIRED: root rebind requires --confirm'); return 2;
    }
    const expectedStoredRootDigest = reqStr(f, 'expected-stored-root-digest');
    if (!expectedStoredRootDigest) {
      error('USAGE: --expected-stored-root-digest SHA256 is required'); return 2;
    }

    const result = rebindProjectRoot(candidateRoot, runId, {
      actor,
      confirm: true,
      expectedStoredRootDigest,
      fence: { owner, generation: Number(f.generation) },
      now: parseNow(f),
    });
    json(result);
    return 0;
  },
  'runtime-executable': async (a) => {
    const [verb, ...rest] = a;
    const f = parseFlags(rest);
    if (verb !== 'diagnose' && verb !== 'approve') {
      error(`unknown runtime-executable verb: ${verb ?? '<none>'}`);
      return 2;
    }
    const runtime = reqStr(f, 'runtime');
    if (!runtime) { error('USAGE: --runtime <claude|codex> is required'); return 2; }
    const candidatePath = reqStr(f, 'path');
    if (!candidatePath) { error('USAGE: --path ABSOLUTE_EXECUTABLE_OR_WRAPPER is required'); return 2; }

    if (verb === 'diagnose') {
      json(diagnoseRuntimeExecutable(runtime, { explicitPath: candidatePath }));
      return 0;
    }

    const expectedCanonicalPath = reqStr(f, 'canonical-path');
    if (!expectedCanonicalPath) { error('USAGE: --canonical-path ABSOLUTE_NATIVE_EXECUTABLE is required'); return 2; }
    const expectedSha256 = reqStr(f, 'sha256');
    if (!expectedSha256) { error('USAGE: --sha256 LOWERCASE_SHA256 is required'); return 2; }
    const actor = reqStr(f, 'actor');
    if (!actor) { error('USAGE: --actor human is required'); return 2; }
    if (f.confirm !== true && f.confirm !== 'true') {
      error('CONFIRM_REQUIRED: runtime executable approval requires --confirm');
      return 2;
    }
    const owner = reqStr(f, 'owner');
    if (!owner) { error('USAGE: --owner OWNER is required'); return 2; }
    if (f.generation === undefined || f.generation === true) {
      error('USAGE: --generation N is required');
      return 2;
    }
    if (typeof f.generation !== 'string' || !/^(?:0|[1-9]\d*)$/.test(f.generation)
      || !Number.isSafeInteger(Number(f.generation))) {
      throw new Error('INVALID_GENERATION: must be a non-negative safe integer');
    }
    const root = rootOf(f);
    const runId = runIdOf(root, f);
    if (!runId) { error('USAGE: --run-id RUN_ID or .deep-loop/current is required'); return 2; }
    const result = approveRuntimeExecutable(root, runId, {
      runtime,
      candidatePath,
      expectedCanonicalPath,
      expectedSha256,
      actor,
      confirm: true,
      fence: { owner, generation: Number(f.generation) },
      now: parseNow(f),
    });
    json(result);
    return 0;
  },
  'launcher-executable': async (a) => {
    const [verb, ...rest] = a;
    const f = parseFlags(rest);
    if (verb !== 'diagnose' && verb !== 'approve') {
      error(`unknown launcher-executable verb: ${verb ?? '<none>'}`);
      return 2;
    }
    if (flagOccurrences(rest, 'path') > 1) {
      throw new Error('LAUNCHER_EXECUTABLE_AMBIGUOUS: exactly one explicit candidate path is required');
    }
    const kind = reqStr(f, 'kind');
    if (!kind) { error('USAGE: --kind <wt|powershell> is required'); return 2; }
    const candidatePath = reqStr(f, 'path');
    if (!candidatePath) { error('USAGE: --path ABSOLUTE_NATIVE_LAUNCHER is required'); return 2; }

    if (verb === 'diagnose') {
      json(diagnoseLauncherExecutable(kind, { explicitPath: candidatePath }));
      return 0;
    }

    const expectedCanonicalPath = reqStr(f, 'canonical-path');
    if (!expectedCanonicalPath) { error('USAGE: --canonical-path ABSOLUTE_NATIVE_LAUNCHER is required'); return 2; }
    const expectedSha256 = reqStr(f, 'sha256');
    if (!expectedSha256) { error('USAGE: --sha256 LOWERCASE_SHA256 is required'); return 2; }
    const actor = reqStr(f, 'actor');
    if (!actor) { error('USAGE: --actor human is required'); return 2; }
    if (f.confirm !== true && f.confirm !== 'true') {
      error('CONFIRM_REQUIRED: launcher executable approval requires --confirm');
      return 2;
    }
    const owner = reqStr(f, 'owner');
    if (!owner) { error('USAGE: --owner OWNER is required'); return 2; }
    if (f.generation === undefined || f.generation === true) {
      error('USAGE: --generation N is required');
      return 2;
    }
    if (typeof f.generation !== 'string' || !/^(?:0|[1-9]\d*)$/.test(f.generation)
      || !Number.isSafeInteger(Number(f.generation))) {
      throw new Error('INVALID_GENERATION: must be a non-negative safe integer');
    }
    const root = rootOf(f);
    const runId = runIdOf(root, f);
    if (!runId) { error('USAGE: --run-id RUN_ID or .deep-loop/current is required'); return 2; }
    const result = approveLauncherExecutable(root, runId, {
      kind,
      candidatePath,
      expectedCanonicalPath,
      expectedSha256,
      actor,
      confirm: true,
      fence: { owner, generation: Number(f.generation) },
      now: parseNow(f),
    });
    json(result);
    return 0;
  },
  'init-run': async (a) => {
    const f = parseFlags(a);
    const root = rootOf(f);
    const runtime = reqStr(f, 'runtime');
    if (!runtime) { error('USAGE: --runtime <claude|codex> is required'); return 2; }
    if (f.model === true || f.effort === true) { error('USAGE: --model/--effort require a value'); return 2; }
    if (f.continuation === true) { error('usage: --continuation <compact-in-place|rotate-per-unit>'); return 2; }
    const model = f.model !== undefined ? String(f.model) : null;
    const effort = f.effort !== undefined ? String(f.effort) : null;
    try {
      const { runId } = initRun(root, { runtime, goal: f.goal, protocol: f.protocol, recipe: f.recipe, detected: detectPlugins(root), review: f.review ? JSON.parse(f.review) : undefined, model, effort, continuation: f.continuation ?? null });
      json({ run_id: runId }); return 0;
    } catch (e) {
      error(String(e?.message || e)); return 1;   // INVALID_RUNTIME / INVALID_MODEL / INVALID_EFFORT → exit 1 (fail-closed)
    }
  },
  'next-action': async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json(nextAction(data, { now: parseNow(f) })); return 0; },
  tick: async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json({ mode: f.mode || 'advance', ...nextAction(data, { now: parseNow(f) }) }); return 0; },
  lease: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readState(root, runId); json(leaseCheck(data, { owner: strArg(f, 'owner'), generation: intArg(f, 'generation') })); return 0; }
    if (verb === 'acquire') {
      const owner = strArg(f, 'owner');
      const expectGeneration = intArg(f, f['expect-generation'] !== undefined ? 'expect-generation' : 'generation');
      const runtime = reqStr(f, 'runtime');
      if (!runtime) { error('USAGE: --runtime <claude|codex> is required'); return 2; }
      let r;
      try { r = acquireLease(root, runId, { owner, expectGeneration, runtime }); }
      catch (e) {
        const classified = classifyKernelError(e);
        if (!classified) throw e;
        error(classified.message); return classified.code;
      }
      json(r);
      // terminal/runtime fence는 exit 3 — resume의 소유권 인수 경계에서 성공-모양(exit 0)으로 위장 금지.
      // 그 외 ok:false(generation/takeability)는 기존 exit 0 + JSON 계약을 유지한다.
      return (r.ok === false && (r.reason === 'run-terminal' || r.reason === 'RUNTIME_FENCED')) ? 3 : 0;
    }
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
      const independentSubagent = f['independent-subagent'] === true || f['independent-subagent'] === 'true';
      json(dispatchReview(root, runId, { point, workstreamId: workstream, detected: detectPlugins(root), independentSubagent, fence })); return 0;
    }
    // verdict 기록 → checker 터미널 파생 + breaker/comprehension/review_points (Codex r1 🔴6: CLI 경계로 노출)
    if (verb === 'record') {
      for (const key of ['source', 'workstream', 'workstream-id', 'workstream_id', 'point', 'target-maker', 'target_maker', 'reviewer-id', 'reviewer_id', 'review-source', 'review_source', 'runtime', 'attempt-id', 'attempt_id', 'attemptId']) {
        if (Object.hasOwn(f, key)) { error(`REVIEW_METADATA_FORBIDDEN: review record derives ${key}`); return 1; }
      }
      const episode = reqStr(f, 'episode'); if (!episode) { error('MISSING_EPISODE'); return 2; }
      const verdict = reqStr(f, 'verdict'); if (!verdict) { error('MISSING_VERDICT'); return 2; }
      // --report (required for a passing verdict) / --findings (optional aux). The CLI does NOT pre-gate by
      // verdict — the lib decides (CLI-bypass safe); a missing report on APPROVE/CONCERN surfaces REVIEW_NO_EVIDENCE.
      const report = f.report && f.report !== true ? String(f.report) : undefined;
      const findings = f.findings && f.findings !== true ? String(f.findings) : undefined;
      try { json(recordReviewOutcome(root, runId, { episodeId: episode, verdict, proof: { report, findings }, fence })); return 0; }
      catch (e) {
        const classified = classifyKernelError(e);
        if (classified) { error(classified.message); return classified.code; }
        error(e.message); return 1;
      }
    }
    if (verb === 'import') {
      for (const key of ['source', 'workstream', 'workstream-id', 'workstream_id', 'point', 'target-maker', 'target_maker', 'reviewer-id', 'reviewer_id', 'review-source', 'review_source', 'runtime', 'attempt-id', 'attempt_id', 'attemptId']) {
        if (Object.hasOwn(f, key)) { error(`REVIEW_METADATA_FORBIDDEN: review import derives ${key}`); return 1; }
      }
      if (f.stdin !== true) { error('STDIN_REQUIRED: review import requires --stdin'); return 2; }
      try {
        const raw = await readBoundedText(process.stdin);
        json(importReviewOutcome(root, runId, { raw, fence, now: parseNow(f) }));
        return 0;
      } catch (e) {
        const classified = classifyKernelError(e);
        if (classified) { error(classified.message); return classified.code; }
        error(e.message); return 1;
      }
    }
    error(`unknown review verb: ${verb}`); return 2;
  },
  handoff: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    const data = requireLease(root, runId, f, 'lease');
    const expect = { owner: f.owner, generation: intArg(f, 'generation') };
    if (verb === 'emit') {
      const h = f.headless === true || f.headless === 'true';
      // v1.6 (spec §2.3-2 CLI 매핑): 기존 RUN_PAUSED/HANDOFF_KEY_MISMATCH throw의 uncaught stack 해소 —
      // respawn/pause/recover 핸들러와 동일 패턴. RUN_TERMINAL은 보상 롤백 후 반환 계약(JSON ok:false)이라 여기 안 걸린다.
      try { json(emitHandoff(root, runId, { reason: f.reason, trigger: f.trigger || f.reason || 'milestone', headless: h, expect, env: process.env })); return 0; }
      catch (e) { const m = String(e?.message || e); if (m.startsWith('LEASE_FENCED')) { error(m); return 3; } error(m); return 1; }
    }
    error(`unknown handoff verb: ${verb}`); return 2;
  },
  // respawn --owner <id> --generation <n> [--attended] [--headless]
  // Resolve the spawn mode first: headless routes through the shared measured host; visible/desktop routes through
  // respawn + visibleSpawn. The caller fence is carried into either path and checked again before CAS.
  respawn: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    if (!runId) { error('MISSING_RUN_ID'); return 2; }
    const { data } = readState(root, runId);
    if (f['dry-run']) { json(respawnGate(data)); return 0; }
    // Require + fence --owner/--generation (exit 3). intent 'lease' so a releasing handoff lease is not rejected.
    requireLease(root, runId, f, 'lease');
    const headless = f.headless === true || f.headless === 'true';
    const attended = f.attended === true || f.attended === 'true';
    let timeoutMs;
    if (Object.hasOwn(f, 'timeout-ms')) {
      timeoutMs = optInt(f, 'timeout-ms');
      if (timeoutMs == null || !Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
        error('INVALID_TIMEOUT_MS: --timeout-ms must be an integer from 0 through 2147483647');
        return 1;
      }
    }
    const mode = resolveSpawnMode(data, { headless, attended, env: process.env });
    const lease = data.session_chain?.lease || {};
    const childRunId = lease.handoff_child_run_id;
    const key = lease.handoff_idempotency_key;
    const cs = (data.session_chain?.sessions || []).find(s => s.run_id === childRunId);
    const handoffRel = cs && cs.handoff_rel;
    const pollLease = () => readState(root, runId).data.session_chain.lease;
    const expect = { owner: f.owner, generation: intArg(f, 'generation') };
    const now = parseNow(f);
    try {
      const r = mode === 'headless'
        ? driveHeadlessRun({
          root, runId, expect, headless, now, timeoutMs, env: process.env,
          // An explicit --now pins deterministic tests/diagnosis; ordinary CLI runs refresh after preflight.
          clock: f.now === undefined ? Date.now : null,
          overrideVisiblePolicy: headless,
        })
        : respawn(root, runId, {
          childRunId, key, handoffRel, headless, attended, now,
          spawnFn: visibleSpawn, pollLease, env: process.env,
          expect, expectedMode: mode,
        });
      json({ mode, ...r });
      return r.ok ? 0 : (r.outcome === 'fenced' || r.outcome === 'terminal' || r.action === 'fenced' || r.action === 'terminal' ? 3 : 0);   // v1.6: terminal 거부는 fence 채널 — soft error(0) 위장 금지 (spec §2.3-5)
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
  // insights [--run <id>] | insights emit --owner --generation | insights latest
  // compute/latest = read-only (fence 불필요, spec §6). emit = mutating → requireLease(외곽) + lib preCheck(락 안).
  insights: async (a) => {
    const verb = a[0] && !a[0].startsWith('--') ? a[0] : null;
    const f = parseFlags(verb ? a.slice(1) : a);
    const root = rootOf(f);
    if (verb === null) {
      const selfRunId = runIdOf(root, f);
      if (f.run !== undefined) {
        const target = String(f.run);
        // runDir는 unsafe path segment('/'·'..' 등)에 RUN_ID_INVALID를 throw — read-only 조회에서는
        // 존재하지 않는 run과 동일하게 clean exit 1로 취급한다 (uncaught 스택 금지, impl-R2 ℹ️7).
        let targetDir;
        try { targetDir = runDir(root, target); } catch { error(`RUN_NOT_FOUND: ${target}`); return 1; }
        if (!existsSync(targetDir)) { error(`RUN_NOT_FOUND: ${target}`); return 1; }
        const out = computeInsights(root, { selfRunId, now: parseNow(f) });
        json({ ...out, per_run: { [target]: out.per_run[target] ?? null } }); return 0;
      }
      json(computeInsights(root, { selfRunId, now: parseNow(f) })); return 0;
    }
    if (verb === 'latest') { json(latestInsights(root)); return 0; }
    if (verb === 'emit') {
      const runId = runIdOf(root, f);
      requireLease(root, runId, f);
      const nowMs = parseNow(f);
      // Phase6 warning-1: reject future-skewed --now here — emitInsights names the artifact ulid(now) and
      // latestInsights picks the lexicographically-last filename, so a future --now would permanently pin a
      // stale candidate ahead of every later legitimate emit (past --now is self-healing, so only future is blocked).
      if (f.now !== undefined && nowMs > Date.now() + 60_000) { error('INSIGHTS_NOW_FUTURE: --now must not be more than 60s in the future'); return 1; }
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      try { json(emitInsights(root, runId, { fence, now: nowMs })); return 0; }
      catch (e) { const m = String(e?.message || e); if (m.startsWith('LEASE_FENCED')) { error(m); return 3; } error(m); return 1; }
    }
    error(`unknown insights verb: ${verb}`); return 2;
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
    const confirm = f.confirm === true || f.confirm === 'true';
    // #4: stopped is a human-only bypass of completed-proof — mirror the abandon/recover/breaker-reset fast-fail
    // (exit 2). Authoritative guard is in finishRun (CLI-bypass safe); completed is unaffected.
    if (status === 'stopped' && !confirm) { error('CONFIRM_REQUIRED: stopped requires --confirm (human-only)'); return 2; }
    const reportRel = f.report && f.report !== true ? String(f.report) : undefined;
    if (reportRel && (reportRel.startsWith('/') || reportRel.split('/').includes('..'))) { error('FINISH_REPORT_PATH_UNSAFE'); return 1; }
    let proof; try { proof = f.proof ? JSON.parse(f.proof) : {}; } catch { error('INVALID_PROOF: must be JSON'); return 1; }   // 무효 값 → exit 1
    try { const r = finishRun(root, runId, { status, reportRel, proof, confirm, fence, now: parseNow(f) }); json(r); return 0; }
    catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }   // FINISH_STATUS_INVALID/PROOF_UNMET → exit 1
  },
};

const fn = handlers[sub];
if (!fn) { error(`unknown subcommand: ${sub ?? '<none>'}`); process.exit(2); }
// 명시적으로 분류된 커널 계약 오류만 변환하는 좁은 catch — 그 외 예외는 기존 fail-stop(uncaught) 그대로 재-throw
// (integrity 등의 detect-and-fail-stop 모델을 넓은 catch로 삼키지 않는다).
try {
  process.exit(await fn(rest));
} catch (e) {
  const classified = classifyKernelError(e);
  if (classified) { error(classified.message); process.exit(classified.code); }
  throw e;
}
