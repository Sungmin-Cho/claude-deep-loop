#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { error } from './lib/log.mjs';
import { buildFixedInitializationRequest, buildInitialLoop, commitFixedInitialization,
  initRun, normalizeFixedReview, prepareFixedInitialization, preflightFixedInitialization,
  statusFixedInitialization } from './lib/initrun.mjs';
import { detectPlugins } from './lib/detect.mjs';
import { matchRecipe, recipesDir, validateRecipesDir } from './lib/recipes.mjs';
import { json } from './lib/log.mjs';
import { validate as validateLoop, verifyAppEventCorrelation } from './lib/schema.mjs';
import { readLines, readVerifiedState, verifyHeadLines, verifyLines } from './lib/integrity.mjs';
import { readState, writeState, patch as patchState, pauseRun, runDir, findRoot } from './lib/state.mjs';
import { leaseCheck, acquireLease, releaseLease } from './lib/lease.mjs';
import { newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal } from './lib/workspace.mjs';
import { newEpisode, recordEpisode, abandonEpisode } from './lib/episode.mjs';
import { dispatchReview, importReviewOutcome, recordReviewOutcome } from './lib/review.mjs';
import { readBoundedText, readStructuredLine } from './lib/bounded-input.mjs';
import { classifyProjectTaskDirectory, exactRawHostObservation,
  normalizeHostObservation } from './lib/host-surface.mjs';
import { observeHostSurface, redactAppSecrets, revokeAppTaskContinuation,
  statusAppTask } from './lib/app-task-continuation.mjs';
import { canonicalProjectRoot } from './lib/project-root.mjs';
import { contentHash } from './lib/envelope.mjs';
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

const SHA_OR_NONE = /^(?:NONE|[0-9a-f]{64})$/;
const INIT_ATTEMPT = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const APP_CAPABILITY = new Set([
  'list-projects', 'create-thread-local', 'fork-thread-same-directory',
  'send-message-to-thread', 'structured-process-stdin',
]);
const FIXED_INIT_COMMON = [
  'project-root', 'runtime', 'goal', 'protocol', 'recipe', 'review', 'model', 'effort',
  'app-continuation', 'app-consent-authority', 'manual-enums', 'host-surface',
  'host-source', 'capabilities',
];
const FIXED_INIT_FLAGS = Object.freeze({
  preflight: new Set(['project-root', 'runtime', 'stdin-mode', 'preflight-nonce',
    'observation-stdin']),
  prepare: new Set([...FIXED_INIT_COMMON, 'expected-observation-digest']),
  status: new Set(['project-root', 'attempt', 'expected-current-digest',
    'expected-request-digest']),
  full: new Set([...FIXED_INIT_COMMON, 'init-attempt', 'expected-current-digest',
    'expected-request-digest', 'expected-preflight-digest', 'stdin-mode',
    'app-host-input-stdin', 'prepared-authority']),
});
const FIXED_INIT_ONLY_FLAGS = new Set([
  'app-continuation', 'app-consent-authority', 'manual-enums', 'host-surface',
  'host-source', 'capabilities', 'expected-observation-digest', 'init-attempt',
  'expected-current-digest', 'expected-request-digest', 'expected-preflight-digest',
  'stdin-mode', 'app-host-input-stdin', 'observation-stdin', 'preflight-nonce', 'attempt',
  'prepared-authority',
]);

function hasFixedInitOnlyFlag(argv) {
  return argv.some(token => typeof token === 'string' && token.startsWith('--')
    && FIXED_INIT_ONLY_FLAGS.has(token.slice(2).split('=', 1)[0]));
}

function assertExactFlagGrammar(argv, allowed) {
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--') || token === '--') {
      throw new Error('USAGE_UNKNOWN_FLAG');
    }
    const body = token.slice(2);
    const equals = body.indexOf('=');
    const name = equals < 0 ? body : body.slice(0, equals);
    if (!allowed.has(name) || seen.has(name)) throw new Error('USAGE_UNKNOWN_FLAG');
    seen.add(name);
    if (equals < 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) index += 1;
  }
}

function explicitRoot(f) {
  if (typeof f['project-root'] !== 'string' || f['project-root'].length === 0) {
    throw new Error('USAGE_FIXED_ROOT_REQUIRED');
  }
  return f['project-root'];
}

function oneCapabilityList(f, argv, { manual = false } = {}) {
  const count = flagOccurrences(argv, 'capabilities');
  if (count === 0) return [];
  if (count !== 1 || typeof f.capabilities !== 'string' || f.capabilities.length === 0) {
    throw new Error('USAGE_CAPABILITIES');
  }
  const values = f.capabilities.split(',');
  if (values.some(value => !APP_CAPABILITY.has(value)) || new Set(values).size !== values.length
      || (manual && values.includes('structured-process-stdin'))) {
    throw new Error('USAGE_CAPABILITIES');
  }
  return values.sort();
}

function exactInitBinding(f, { status = false } = {}) {
  const attempt = status ? f.attempt : f['init-attempt'];
  if (!INIT_ATTEMPT.test(attempt || '')
      || !SHA_OR_NONE.test(f['expected-current-digest'] || '')
      || !/^[0-9a-f]{64}$/.test(f['expected-request-digest'] || '')) {
    throw new Error('USAGE_INIT_BINDING');
  }
  return { attempt_id: attempt, expected_current_digest: f['expected-current-digest'],
    expected_request_digest: f['expected-request-digest'] };
}

function exactConsentFlags(f) {
  const mode = f['app-continuation']; const authority = f['app-consent-authority'];
  if (!((mode === 'manual' && authority === 'default-manual')
      || (mode === 'auto' && authority === 'human-confirmed'))) {
    throw new Error('USAGE_INIT_CONSENT');
  }
  return { mode, authority };
}

function manualEnumProfile(f, argv, expectedObservation) {
  const forbidden = ['stdin-mode', 'observation-stdin', 'app-host-input-stdin', 'host-task-cwd'];
  if (forbidden.some(name => f[name] !== undefined) || expectedObservation !== 'NONE'
      || f['app-continuation'] !== 'manual'
      || f['app-consent-authority'] !== 'default-manual') throw new Error('USAGE_MANUAL_ENUMS');
  const surface = f['host-surface']; const source = f['host-source'];
  const nullPair = surface === undefined && source === undefined;
  const validPairs = f.runtime === 'codex'
    ? { 'codex-cli': 'codex-cli-host', 'codex-app': 'codex-app-tool-provenance' }
    : f.runtime === 'claude'
      ? { 'claude-code': 'claude-cli-entrypoint',
        'claude-desktop': 'claude-desktop-local-agent' }
      : {};
  if (!nullPair && validPairs[surface] !== source) throw new Error('USAGE_MANUAL_ENUMS');
  const capabilities = oneCapabilityList(f, argv, { manual: true });
  if (nullPair && capabilities.length !== 0) throw new Error('USAGE_MANUAL_ENUMS');
  return { kind: nullPair ? null : surface, source: nullPair ? null : source, capabilities };
}

function nativeObservationDeps(kernelCwd) {
  return { platform: process.platform, kernelCwd,
    realpath: value => (realpathSync.native || realpathSync)(value),
    stat: value => statSync(value, { bigint: true }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino,
    exists: existsSync };
}

function explicitFixedRoot(f) {
  const root = canonicalProjectRoot(explicitRoot(f));
  const actualCwd = canonicalProjectRoot(process.cwd());
  const native = nativeObservationDeps(actualCwd);
  if (classifyProjectTaskDirectory(root, actualCwd, native) === null) {
    throw new Error('PROJECT_ROOT_FENCED: fixed init cwd is neither the explicit root nor one exact internal worktree');
  }
  return { root, native };
}

const boundedFixedLiteral = value => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= 16_384
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

function parseFixedReviewFlag(f) {
  if (f.review === undefined) return null;
  if (typeof f.review !== 'string' || f.review.length === 0
      || Buffer.byteLength(f.review, 'utf8') > 16_384
      || /[\u0000-\u001f\u007f-\u009f]/u.test(f.review)) throw new Error('USAGE_INIT_REVIEW');
  let parsed;
  try { parsed = JSON.parse(f.review); } catch { throw new Error('USAGE_INIT_REVIEW'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('USAGE_INIT_REVIEW');
  }
  try { return normalizeFixedReview(parsed); } catch { throw new Error('USAGE_INIT_REVIEW'); }
}

function validateFixedRequestFlags(f, { preflight = false } = {}) {
  if (!['claude', 'codex'].includes(f.runtime)) throw new Error('USAGE_INIT_RUNTIME');
  if (preflight) return;
  if (!boundedFixedLiteral(f.goal)) throw new Error('USAGE_INIT_GOAL');
  parseFixedReviewFlag(f);
  if (f.protocol !== undefined && !['deep-work', 'superpowers', 'standalone'].includes(f.protocol)) {
    throw new Error('USAGE_INIT_PROTOCOL');
  }
  if (f.recipe !== undefined && !boundedFixedLiteral(f.recipe)) throw new Error('USAGE_INIT_RECIPE');
  if (f.model !== undefined && (!boundedFixedLiteral(f.model)
      || !/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,127}$/.test(f.model))) throw new Error('USAGE_INIT_MODEL');
  if (f.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(f.effort)) {
    throw new Error('USAGE_INIT_EFFORT');
  }
}

function exactPreparedAuthority(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw, 'utf8') > 16_384
      || /[\u0000-\u001f\u007f-\u009f]/u.test(raw)) throw new Error('USAGE_PREPARED_AUTHORITY');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('USAGE_PREPARED_AUTHORITY'); }
  if (JSON.stringify(value) !== raw) throw new Error('USAGE_PREPARED_AUTHORITY');
  const exactKeys = (object, expected) => object && typeof object === 'object'
    && !Array.isArray(object) && Object.getPrototypeOf(object) === Object.prototype
    && Object.keys(object).sort().join('\0') === [...expected].sort().join('\0');
  const identity = candidate => exactKeys(candidate, ['realpath', 'dev', 'ino'])
    && boundedFixedLiteral(candidate.realpath) && typeof candidate.dev === 'string'
    && typeof candidate.ino === 'string' && /^(?:0|[1-9][0-9]*)$/.test(candidate.dev)
    && /^(?:0|[1-9][0-9]*)$/.test(candidate.ino);
  if (!exactKeys(value, ['version', 'root', 'cwd']) || value.version !== 1
      || !identity(value.root) || !(value.cwd === null || identity(value.cwd))) {
    throw new Error('USAGE_PREPARED_AUTHORITY');
  }
  return { value, digest: contentHash(raw) };
}

function verifyFixedPreparedAuthority(root, authority, expectedObservation, native) {
  const sameIdentity = (path, expected) => {
    try {
      const realpath = native.realpath(path);
      const stat = native.stat(realpath);
      const samePath = native.platform === 'win32'
        ? realpath.toLowerCase() === expected.realpath.toLowerCase()
        : realpath === expected.realpath;
      return stat?.isDirectory?.() === true && samePath
        && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
    } catch { return false; }
  };
  const cwdRequired = expectedObservation !== 'NONE';
  if (!sameIdentity(root, authority.root)
      || cwdRequired !== (authority.cwd !== null)
      || cwdRequired && !sameIdentity(native.kernelCwd, authority.cwd)) {
    throw new Error('INIT_PREPARED_AUTHORITY_MISMATCH');
  }
}

async function readStructuredJson(options) {
  const line = await readStructuredLine(process.stdin, options);
  try { return JSON.parse(line); } catch { throw new Error('STRUCTURED_JSON_INVALID'); }
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
  if (/^RUN_SNAPSHOT_INVALID(?::|$)/.test(message)) {
    return { code: 1, message };
  }
  if (/^(?:APP_TASK_FENCED|HOST_SURFACE_FENCED)(?::|$)/.test(message)) {
    return { code: 3, message };
  }
  if (/^(?:APP_TASK_TERMINAL|APP_TASK_CONSENT_INVALID|APP_TASK_TRANSITION_INVALID|HOST_SURFACE_TERMINAL)(?::|$)/.test(message)) {
    return { code: 1, message };
  }
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

function appFenceSyntax(f) {
  const runId = reqStr(f, 'run-id');
  const owner = reqStr(f, 'owner');
  const runtime = reqStr(f, 'runtime');
  if (runId === null || owner === null || !['claude', 'codex'].includes(runtime)
      || typeof f.generation !== 'string'
      || !/^(?:0|[1-9][0-9]*)$/.test(f.generation)
      || !Number.isSafeInteger(Number(f.generation))) return null;
  return { runId, owner, runtime, generation: Number(f.generation) };
}

const APP_TASK_FLAGS = Object.freeze({
  status: new Set(['project-root', 'run-id', 'attempt']),
  revoke: new Set(['project-root', 'run-id', 'owner', 'generation', 'runtime']),
});

const appTaskHandler = async argv => {
  const [verb, ...flagArgs] = argv;
  if (!Object.hasOwn(APP_TASK_FLAGS, verb)) return 2;
  try { assertExactFlagGrammar(flagArgs, APP_TASK_FLAGS[verb]); }
  catch { return 2; }
  const f = parseFlags(flagArgs);
  let root;
  try { root = explicitRoot(f); }
  catch { return 2; }
  if (verb === 'status') {
    const runId = reqStr(f, 'run-id');
    if (runId === null || f.attempt === true
        || f.attempt !== undefined && !INIT_ATTEMPT.test(f.attempt)) return 2;
    json(statusAppTask(root, runId, { attempt: f.attempt ?? null }));
    return 0;
  }
  if (verb !== 'revoke') return 2;
  const syntax = appFenceSyntax(f);
  if (syntax === null) return 2;
  json(revokeAppTaskContinuation(root, syntax.runId, {
    owner: syntax.owner, generation: syntax.generation, runtime: syntax.runtime,
  }));
  return 0;
};
function requireLease(root, runId, f, intent = 'business') {
  strArg(f, 'owner');
  const generation = intArg(f, 'generation');
  let data;
  try {
    data = readVerifiedState(root, runId, { fenceCheck: loop => {
      const lease = loop.session_chain?.lease;
      if (lease?.owner_run_id !== f.owner || lease?.generation !== generation) {
        throw new Error('LEASE_FENCED: owner-or-generation-mismatch');
      }
    } }).data;
  } catch (caught) {
    if (String(caught?.message || caught).startsWith('LEASE_FENCED:')) {
      error(String(caught.message || caught));
      process.exit(3);
    }
    throw caught;
  }
  const checked = leaseCheck(data, { owner: f.owner, generation, intent });
  if (!checked.ok) {
    error('LEASE_FENCED: ' + checked.reason);
    process.exit(3);
  }
  return data;
}

const [, , sub, ...rest] = process.argv;

async function dispatchFixedInit(argv) {
  const verb = ['preflight', 'prepare', 'status'].includes(argv[0]) ? argv[0] : 'full';
  const flagArgs = verb === 'full' ? argv : argv.slice(1);
  assertExactFlagGrammar(flagArgs, FIXED_INIT_FLAGS[verb]);
  const f = parseFlags(flagArgs);
  const { root, native } = explicitFixedRoot(f);
  if (verb === 'status') return statusFixedInitialization(root, exactInitBinding(f, { status: true }));
  validateFixedRequestFlags(f, { preflight: verb === 'preflight' });
  if (verb === 'preflight') {
    const mode = f['stdin-mode'];
    if (!['pipe-open-noecho', 'pty-raw-noecho'].includes(mode)
        || f['observation-stdin'] !== true
        || !/^[0-9a-f]{32}$/.test(f['preflight-nonce'] || '')) {
      throw new Error('USAGE_STRUCTURED_INIT');
    }
    const raw = await readStructuredJson({ mode, purpose: 'init-preflight',
      binding: f['preflight-nonce'], maxBytes: 32_768,
      writeReady: token => process.stdout.write(`${token}\n`) });
    return preflightFixedInitialization(root, { runtime: f.runtime,
      nonce: f['preflight-nonce'], readerMode: mode, observation: raw });
  }
  if (f['manual-enums'] !== undefined && f['manual-enums'] !== true) {
    throw new Error('USAGE_MANUAL_ENUMS');
  }
  const manual = f['manual-enums'] === true;
  const consent = exactConsentFlags(f);
  const review = parseFixedReviewFlag(f);
  if (!manual && ['host-surface', 'host-source', 'capabilities']
    .some(name => f[name] !== undefined)) throw new Error('USAGE_STRUCTURED_INIT');
  if (verb === 'prepare') {
    if (f['stdin-mode'] !== undefined || f['observation-stdin'] !== undefined
        || f['app-host-input-stdin'] !== undefined) throw new Error('USAGE_PREPARE_STDIN');
    const expectedObservation = f['expected-observation-digest'];
    if (!SHA_OR_NONE.test(expectedObservation || '')) throw new Error('USAGE_OBSERVATION_DIGEST');
    const enumProfile = manual ? manualEnumProfile(f, flagArgs, expectedObservation) : null;
    if (!manual && expectedObservation === 'NONE') throw new Error('USAGE_OBSERVATION_DIGEST');
    const request = buildFixedInitializationRequest({ root, runtime: f.runtime, goal: f.goal,
      protocol: f.protocol, recipe: f.recipe, review, model: f.model, effort: f.effort,
      consentMode: consent.mode, consentAuthority: consent.authority,
      observationDigest: expectedObservation, enumProfile });
    return prepareFixedInitialization(root, request);
  }
  if (flagOccurrences(flagArgs, 'init-attempt') !== 1) throw new Error('USAGE_INIT_BINDING');
  const binding = exactInitBinding(f);
  const expectedObservation = f['expected-preflight-digest'];
  if (!SHA_OR_NONE.test(expectedObservation || '')) throw new Error('USAGE_OBSERVATION_DIGEST');
  const authority = exactPreparedAuthority(f['prepared-authority']);
  verifyFixedPreparedAuthority(root, authority.value, expectedObservation, native);
  let observation = null; let enumProfile = null;
  if (manual) {
    enumProfile = manualEnumProfile(f, flagArgs, expectedObservation);
  } else {
    const mode = f['stdin-mode'];
    if (!['pipe-open-noecho', 'pty-raw-noecho'].includes(mode)
        || f['app-host-input-stdin'] !== true || expectedObservation === 'NONE') {
      throw new Error('USAGE_STRUCTURED_INIT');
    }
    const readyBinding = [binding.attempt_id, binding.expected_current_digest,
      binding.expected_request_digest, expectedObservation, authority.digest].join('.');
    const raw = await readStructuredJson({ mode, purpose: 'init-commit', binding: readyBinding,
      maxBytes: 32_768, writeReady: token => process.stdout.write(`${token}\n`) });
    const exactRaw = exactRawHostObservation(raw);
    observation = normalizeHostObservation({ ...exactRaw, runtime: f.runtime,
      observed_at: null }, native);
    if (observation.structured_stdin_mode !== mode) throw new Error('INIT_BINDING_FENCED');
  }
  const request = buildFixedInitializationRequest({ root, runtime: f.runtime, goal: f.goal,
    protocol: f.protocol, recipe: f.recipe, review, model: f.model, effort: f.effort,
    consentMode: consent.mode, consentAuthority: consent.authority,
    observationDigest: expectedObservation, enumProfile });
  return commitFixedInitialization(root, { request, observation, prepared: {
    ok: true, outcome: 'prepared', attempt_id: binding.attempt_id,
    previous_current_digest: binding.expected_current_digest,
    expected_request_digest: binding.expected_request_digest,
    expected_observation_digest: expectedObservation,
    prepared_authority: authority.value,
  } });
}

const initRunHandler = async a => {
  const fixedVerb = ['preflight', 'prepare', 'status'].includes(a[0]);
  if (fixedVerb || hasFixedInitOnlyFlag(a)) {
    try { json(await dispatchFixedInit(a)); return 0; }
    catch (failure) {
      const message = String(failure?.message || failure); error(message);
      return message.startsWith('USAGE_') ? 2 : (classifyKernelError(failure)?.code ?? 1);
    }
  }
  const f = parseFlags(a); const root = rootOf(f); const runtime = reqStr(f, 'runtime');
  if (!runtime) { error('USAGE: --runtime <claude|codex> is required'); return 2; }
  if (f.model === true || f.effort === true) {
    error('USAGE: --model/--effort require a value'); return 2;
  }
  try {
    const { runId } = initRun(root, { runtime, goal: f.goal, protocol: f.protocol,
      recipe: f.recipe, detected: detectPlugins(root),
      review: f.review ? JSON.parse(f.review) : undefined,
      model: f.model === undefined ? null : String(f.model),
      effort: f.effort === undefined ? null : String(f.effort) });
    json({ run_id: runId }); return 0;
  } catch (failure) { error(String(failure?.message || failure)); return 1; }
};

function manualObservationFromFlags(f, argv, kernelCwd) {
  const surface = f['host-surface']; const source = f['host-source'];
  const nullPair = surface === 'null' && source === 'null';
  if (!nullPair && (typeof surface !== 'string' || typeof source !== 'string')) {
    throw new Error('USAGE_MANUAL_OBSERVATION');
  }
  return { kind: nullPair ? null : surface, source: nullPair ? null : source,
    capabilities: oneCapabilityList(f, argv, { manual: true }),
    structured_stdin_mode: null, host_task_cwd: null, host_task_cwd_source: null,
    kernel_cwd_at_observation: (realpathSync.native || realpathSync)(kernelCwd), observed_at: null };
}

const HOST_SURFACE_FLAGS = Object.freeze({
  'stdin-probe': new Set(['project-root', 'stdin-mode', 'probe-stdin']),
  observe: new Set(['project-root', 'run-id', 'owner', 'generation', 'runtime',
    'manual-enums', 'stdin-mode', 'observation-stdin', 'host-surface', 'host-source',
    'capabilities']),
});

const hostSurfaceHandler = async argv => {
  const [verb, ...flagArgs] = argv;
  if (!Object.hasOwn(HOST_SURFACE_FLAGS, verb)) return 2;
  try { assertExactFlagGrammar(flagArgs, HOST_SURFACE_FLAGS[verb]); }
  catch { return 2; }
  const f = parseFlags(flagArgs);
  let root;
  try { root = explicitRoot(f); }
  catch { return 2; }
  if (verb === 'stdin-probe') {
    const mode = f['stdin-mode'];
    if (f['probe-stdin'] !== true
        || !['pipe-open-noecho', 'pty-raw-noecho'].includes(mode)) return 2;
    const nonce = randomBytes(16).toString('hex');
    const line = await readStructuredLine(process.stdin, {
      mode, purpose: 'stdin-probe', binding: nonce, maxBytes: 1024,
      writeReady: token => process.stdout.write(token + '\n'),
    });
    json({ ok: true, mode, byte_length: Buffer.byteLength(line),
      sha256: createHash('sha256').update(line).digest('hex') });
    return 0;
  }
  const runId = reqStr(f, 'run-id');
  const owner = reqStr(f, 'owner');
  if (runId === null || owner === null || typeof f.generation !== 'string'
      || !/^(?:0|[1-9][0-9]*)$/.test(f.generation)
      || !Number.isSafeInteger(Number(f.generation))) return 2;
  const generation = Number(f.generation);
  const runtime = reqStr(f, 'runtime');
  if (!['claude', 'codex'].includes(runtime)) return 2;
  if (f['manual-enums'] !== undefined && f['manual-enums'] !== true) return 2;
  const manual = f['manual-enums'] === true;
  const mode = manual ? null : f['stdin-mode'];
  if (manual && (f['stdin-mode'] !== undefined || f['observation-stdin'] !== undefined)) return 2;
  if (!manual && ['host-surface', 'host-source', 'capabilities']
    .some(name => f[name] !== undefined)) return 2;
  if (!manual && (!['pipe-open-noecho', 'pty-raw-noecho'].includes(mode)
      || f['observation-stdin'] !== true)) return 2;
  let observation;
  if (manual) {
    try { observation = manualObservationFromFlags(f, flagArgs, process.cwd()); }
    catch (failure) {
      if (String(failure?.message).startsWith('USAGE_')) return 2;
      throw failure;
    }
  } else {
    observation = await readStructuredJson({
      mode, purpose: 'host-observe', binding: owner + '.' + generation,
      maxBytes: 32_768, writeReady: token => process.stdout.write(token + '\n'),
    });
  }
  json(observeHostSurface(root, runId, { owner, generation, runtime,
    readerMode: mode, observation }, nativeObservationDeps(process.cwd())));
  return 0;
};

// validate: 비공허 검증 (Codex impl 🟡4)
// 1) 스키마+빌더 self-test: buildInitialLoop 산출물이 항상 검증 통과해야 함 (regression 게이트)
// 2) 현재/지정 run이 있으면 readState(해시 검증 발화) + schema.validate
const handlers = {
  'app-task': appTaskHandler,
  'host-surface': hostSurfaceHandler,
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
        const { data } = readVerifiedState(root, runId);
        const rv = validateLoop(data);
        if (!rv.ok) errors.push(`run ${runId}: ${rv.errors.join('; ')}`);
        const lines = readLines(root, runId);
        const lv = verifyLines(lines);
        if (!lv.ok) errors.push(`run ${runId}: event log: ${lv.errors.join('; ')}`);
        const hv = verifyHeadLines(lines, data.event_log_head);
        if (!hv.ok) errors.push(`run ${runId}: event head: ${hv.errors.join('; ')}`);
        const av = verifyAppEventCorrelation(data, lines);
        if (!av.ok) errors.push(`run ${runId}: App event correlation: ${av.errors.join('; ')}`);
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
  'init-run': initRunHandler,
  'next-action': async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readVerifiedState(root, runIdOf(root, f)); json(nextAction(data, { now: parseNow(f) })); return 0; },
  tick: async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readVerifiedState(root, runIdOf(root, f)); json({ mode: f.mode || 'advance', ...nextAction(data, { now: parseNow(f) }) }); return 0; },
  lease: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readVerifiedState(root, runId); json(leaseCheck(data, { owner: strArg(f, 'owner'), generation: intArg(f, 'generation') })); return 0; }
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
      const requestId = reqStr(f, 'request-id');
      if (!requestId) { error('MISSING_REQUIRED_OPTION: --request-id'); return 2; }
      const r = newWorkstream(root, runId,
        { title, branch, worktree, dependsOn, requestId, fence }); json(r); return 0;
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
      const requestId = reqStr(f, 'request-id');
      if (!requestId) { error('MISSING_REQUIRED_OPTION: --request-id'); return 2; }
      const task = reqStr(f, 'task');
      if (!task) { error('MISSING_REQUIRED_OPTION: --task'); return 2; }
      const r = newEpisode(root, runId, { plugin, role, kind, point,
        workstream: f.workstream, expectedArtifacts: f.artifacts ? JSON.parse(f.artifacts) : [],
        fence, requestId, task });
      json({ id: r.id, request_markdown: r.requestMarkdown,
        request_markdown_digest: r.requestMarkdownDigest }); return 0;
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
    // Import intentionally materializes its immutable envelope before taking the commit lock; its
    // authoritative commit re-fences under that lock. Preserve the ordinary verified CLI precheck
    // (including terminal error order) when the lock is free, but if a commit is already in flight,
    // defer authority to importReviewOutcome rather than blocking envelope materialization on it.
    if (verb !== 'import' || !existsSync(join(runDir(root, runId), '.lock'))) {
      requireLease(root, runId, f);
    }
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    if (verb === 'dispatch') {
      const point = reqStr(f, 'point'); if (!point) { error('MISSING_POINT'); return 2; }
      const workstream = reqStr(f, 'workstream'); if (!workstream) { error('MISSING_WORKSTREAM'); return 2; }
      const requestId = reqStr(f, 'request-id');
      if (!requestId) { error('MISSING_REQUIRED_OPTION: --request-id'); return 2; }
      const independentSubagent = f['independent-subagent'] === true || f['independent-subagent'] === 'true';
      json(dispatchReview(root, runId, { point, workstreamId: workstream,
        detected: detectPlugins(root), independentSubagent, requestId, fence })); return 0;
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
      if (!explicit && !existsSync(runDir(root, runId))) { json(null); return 0; }
      let data;
      try { ({ data } = readVerifiedState(root, runId)); }
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
      const field = f.field === undefined || f.field === true ? null : String(f.field);
      const fieldKeys = field === null ? [] : field.split('.');
      const value = field === null ? data
        : fieldKeys.reduce((object, key) => object == null ? undefined : object[key], data);
      json(redactAppSecrets(value === undefined ? null : value, fieldKeys));
      return 0;
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
    if (verb === 'check') { const { data } = readVerifiedState(root, runId); json(checkBudget(data, { now: parseNow(f) })); return 0; }
    if (verb === 'record') {
      requireLease(root, runId, f);
      // Codex r4 sf-4: parseFlags 는 값 없는 플래그를 true 로 둔다 → Number(true)=1 오기록 방지.
      // 미지정 → 0, 지정 시 비음정수 문자열만 허용(true/음수/NaN/Infinity 거부).
      const turns = optInt(f, 'turns'); const tokens = optInt(f, 'tokens');
      if (turns === null || tokens === null) { error('INVALID_COST: --turns/--tokens must be non-negative integers'); return 1; }
      const requestId = reqStr(f, 'request-id');
      if (!requestId) { error('USAGE: --request-id ID is required'); return 2; }
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'accounting' };
      try { recordCost(root, runId, { turns, tokens, requestId, fence }); }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
      const { data } = readVerifiedState(root, runId);
      json({ ok: true, spent: data.budget.spent, tokens_spent: data.budget.tokens_spent }); return 0;
    }
    error(`unknown budget verb: ${verb}`); return 2;
  },
  comprehension: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'status') { const { data } = readVerifiedState(root, runId); json(computeDebt(data)); return 0; }
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
        const { data } = readVerifiedState(root, runId); json({ ok: false, ...computeDebt(data) }); return 2;
      }
      const { data } = readVerifiedState(root, runId); json({ ok: true, ...computeDebt(data) }); return 0;
    }
    error(`unknown comprehension verb: ${verb}`); return 2;
  },
  breaker: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readVerifiedState(root, runId); json(checkBreaker(data)); return 0; }
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
