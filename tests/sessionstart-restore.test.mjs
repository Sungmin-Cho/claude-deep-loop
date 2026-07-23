import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitLegacyCompactCheckpointFromTrustedHook } from '../scripts/lib/checkpoint.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { advanceHandoffPhase, reserveHandoff } from '../scripts/lib/lease.mjs';
import { pauseRun, readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { runSessionStartRestore } from '../scripts/hooks-impl/sessionstart-restore.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';

const PROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESTORE_HOOK = join(PROOT, 'scripts', 'hooks-impl', 'sessionstart-restore.mjs');
const EXPECTED_BOOTSTRAP = `node -e "const{join}=require('node:path');const{pathToFileURL}=require('node:url');const r=process.env.CLAUDE_PLUGIN_ROOT||process.env.PLUGIN_ROOT;if(!r){console.error('deep-loop: plugin root unavailable')}else{import(pathToFileURL(join(r,'scripts','hooks-impl','sessionstart-restore.mjs')).href).then(m=>m.main()).catch(()=>console.error('deep-loop: sessionstart hook failed'))}"`;
const NOW_MS = Date.parse('2026-07-20T00:00:00.000Z');
const NOW = new Date(NOW_MS);
const noRun = () => ({ code: 1, stdout: '', stderr: '' });

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'dl-sessionstart-'));
}

function initClaude(root, extra = {}) {
  const { continuation = 'compact-in-place', ...currentOptions } = extra;
  const result = initRun(root, {
    runtime: 'claude', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1,
    ...currentOptions,
  });
  const dir = runDir(root, result.runId);
  const loopPath = join(dir, 'loop.json');
  const legacy = JSON.parse(readFileSync(loopPath, 'utf8'));
  legacy.schema_version = '0.3.0';
  delete legacy.project.binding_generation;
  delete legacy.autonomy.attended_launch_approval;
  delete legacy.session_chain.lease.takeover_kind;
  for (const session of legacy.session_chain.sessions) delete session.scope;
  legacy.autonomy.spawn_style = 'visible';
  legacy.autonomy.continuation_policy = continuation;
  legacy.autonomy.milestone_predicate = continuation === 'compact-in-place'
    ? ['workstream_status_change']
    : ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached'];
  const raw = JSON.stringify(legacy, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
  return result;
}

const restore = root => runSessionStartRestore({}, { root, now: NOW_MS });
const fence = runId => ({ owner: runId, generation: 1 });
const loopPathOf = (root, runId) => join(runDir(root, runId), 'loop.json');
const hashPathOf = (root, runId) => join(runDir(root, runId), '.loop.hash');

function assertAdvisory(context, runId, generation = 1) {
  assert.ok(context.startsWith('deep-loop lease '), 'lease advisory must be placed first');
  assert.match(context, new RegExp(`owner=${runId} gen=${generation}`));
  assert.match(context, /mutation을 시도하지 말 것/);
}

function stateBytes(root, runId) {
  return [readFileSync(loopPathOf(root, runId), 'utf8'), readFileSync(hashPathOf(root, runId), 'utf8')];
}

function runHook(root, payload) {
  return spawnSync(process.execPath, [RESTORE_HOOK], {
    cwd: root,
    encoding: 'utf8',
    input: typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
    maxBuffer: 2_097_152,
  });
}

test('no run / terminal / paused → no injection', () => {
  const noRunRoot = freshRoot();
  assert.deepEqual(restore(noRunRoot), { ok: true, branch: 'no-run', additionalContext: null });

  const pausedRoot = freshRoot();
  const { runId: pausedRunId } = initClaude(pausedRoot);
  pauseRun(pausedRoot, pausedRunId, {
    reason: 'test', mode: 'preserve', expect: fence(pausedRunId), now: NOW_MS + 1,
  });
  assert.deepEqual(restore(pausedRoot), { ok: true, branch: 'terminal-or-paused', additionalContext: null });

  const stoppedRoot = freshRoot();
  const { runId: stoppedRunId } = initClaude(stoppedRoot);
  finishRun(stoppedRoot, stoppedRunId, {
    status: 'stopped', proof: { human_reason: 'test' }, confirm: true,
    fence: fence(stoppedRunId), now: NOW_MS + 1,
  });
  assert.deepEqual(restore(stoppedRoot), { ok: true, branch: 'terminal-or-paused', additionalContext: null });
});

test('corrupt loop.json → unreadable with null context', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  writeFileSync(loopPathOf(root, runId), '{');

  assert.deepEqual(restore(root), { ok: true, branch: 'unreadable', additionalContext: null });
});

test('bare reserved(active) → recovery capsule, not resume', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  reserveHandoff(root, runId, { trigger: 'milestone', expect: fence(runId), now: NOW_MS + 1 });

  const r = restore(root);

  assert.equal(r.branch, 'reserved-recovery');
  assert.match(r.additionalContext, /reserved-finalization|deep-loop-status/);
  assert.doesNotMatch(r.additionalContext, /새 세션.*resume하라/);
  assertAdvisory(r.additionalContext, runId);
});

test('emitted/releasing with child → rotation capsule with owner advisory', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const emitted = emitHandoff(root, runId, {
    reason: 'milestone', trigger: 'milestone', headless: false,
    expect: fence(runId), env: {}, now: NOW_MS + 1,
  });

  const r = restore(root);

  assert.equal(r.branch, 'rotation');
  assert.match(r.additionalContext, new RegExp(emitted.childRunId));
  assert.match(r.additionalContext, /새 세션/);
  assertAdvisory(r.additionalContext, runId);
});

test('spawned/releasing with child → rotation capsule after emitted→spawned transition', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const emitted = emitHandoff(root, runId, {
    reason: 'milestone', trigger: 'milestone', headless: false,
    expect: fence(runId), env: {}, now: NOW_MS + 1,
  });
  advanceHandoffPhase(root, runId, {
    key: emitted.key,
    toPhase: 'spawned',
    expect: fence(runId),
    now: NOW_MS + 2,
  });

  const r = restore(root);

  assert.equal(r.branch, 'rotation');
  assert.match(r.additionalContext, new RegExp(emitted.childRunId));
  assertAdvisory(r.additionalContext, runId);
});

test('rotate-per-unit + idle → retry-guidance capsule without nonexistent-handoff claim', () => {
  const root = freshRoot();
  const { runId } = initClaude(root, { continuation: 'rotate-per-unit' });

  const r = restore(root);

  assert.equal(r.branch, 'rotate-retry');
  assert.match(r.additionalContext, /handoff 미-emit|emission을 수행/);
  assert.doesNotMatch(r.additionalContext, /reserved child.*resume하라/);
  assertAdvisory(r.additionalContext, runId);
});

test('compact-in-place + matching checkpoint → resume capsule ≤3KB(bytes) with run/ws/episode', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });

  const r = restore(root);

  assert.equal(r.branch, 'resume');
  assert.ok(Buffer.byteLength(r.additionalContext, 'utf8') <= 3072);
  assert.match(r.additionalContext, new RegExp(runId));
  assert.match(r.additionalContext, /ws=/);
  assert.match(r.additionalContext, /episode=/);
  assertAdvisory(r.additionalContext, runId);
});

test('UTF-8 clamp preserves code points and the owner advisory within 3072 bytes', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    expectedArtifacts: [`아티팩트-${'한'.repeat(2_000)}`], fence: fence(runId), now: NOW_MS + 1,
  });
  emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 2 });

  const r = restore(root);

  assert.equal(r.branch, 'resume');
  assert.ok(Buffer.byteLength(r.additionalContext, 'utf8') <= 3072);
  assert.doesNotMatch(r.additionalContext, /\uFFFD/);
  assert.match(r.additionalContext, /\.\.\.$/);
  assertAdvisory(r.additionalContext, runId);
});

test('all checkpoints stale after state advances → degrade to status guidance', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });
  const { data } = readState(root, runId);
  data.discovered_items.push({ note: 'advance state revision' });
  writeState(root, runId, data);

  const r = restore(root);

  assert.equal(r.branch, 'no-checkpoint');
  assert.match(r.additionalContext, /deep-loop-status/);
  assertAdvisory(r.additionalContext, runId);
});

test('checkpoint parse failure after selection → no-checkpoint with advisory', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const checkpoint = emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });

  const r = runSessionStartRestore({}, {
    root,
    now: NOW_MS,
    readCheckpoint: path => path === checkpoint.path ? '{' : readFileSync(path, 'utf8'),
  });

  assert.equal(r.branch, 'no-checkpoint');
  assert.match(r.additionalContext, /deep-loop-status/);
  assertAdvisory(r.additionalContext, runId);
});

test('read-only: loop.json/.loop.hash bytes remain unchanged across capsule branches', () => {
  const fixtures = [];

  {
    const root = freshRoot(); const { runId } = initClaude(root);
    reserveHandoff(root, runId, { trigger: 'milestone', expect: fence(runId), now: NOW_MS + 1 });
    fixtures.push({ root, runId, branch: 'reserved-recovery' });
  }
  {
    const root = freshRoot(); const { runId } = initClaude(root);
    emitHandoff(root, runId, {
      reason: 'milestone', trigger: 'milestone', headless: false,
      expect: fence(runId), env: {}, now: NOW_MS + 1,
    });
    fixtures.push({ root, runId, branch: 'rotation' });
  }
  {
    const root = freshRoot(); const { runId } = initClaude(root, { continuation: 'rotate-per-unit' });
    fixtures.push({ root, runId, branch: 'rotate-retry' });
  }
  {
    const root = freshRoot(); const { runId } = initClaude(root);
    emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });
    fixtures.push({ root, runId, branch: 'resume' });
  }
  {
    const root = freshRoot(); const { runId } = initClaude(root);
    fixtures.push({ root, runId, branch: 'no-checkpoint' });
  }

  for (const { root, runId, branch } of fixtures) {
    const before = stateBytes(root, runId);
    assert.equal(restore(root).branch, branch);
    assert.deepEqual(stateBytes(root, runId), before, `${branch} must not mutate durable state`);
  }
});

test('hooks.json registers SessionStart(compact) with the static shell-free bootstrap', () => {
  const manifest = JSON.parse(readFileSync(join(PROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(manifest.hooks.SessionStart.length, 1);
  assert.equal(manifest.hooks.SessionStart[0].matcher, 'compact');
  assert.equal(manifest.hooks.SessionStart[0].hooks.length, 1);
  const command = manifest.hooks.SessionStart[0].hooks[0].command;
  assert.equal(command, EXPECTED_BOOTSTRAP);
  assert.doesNotMatch(command, /bash|\.sh\b|\$\{|\$\(|`/);
});

test('Claude and Codex compact payloads receive identical additionalContext JSON', () => {
  const root = freshRoot();
  initClaude(root);
  const currentRunId = readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim();
  emitLegacyCompactCheckpointFromTrustedHook(root, currentRunId, { now: NOW_MS + 1 });
  const claude = runHook(root, { cwd: root, hook_event_name: 'SessionStart', source: 'compact', session_id: 'claude-session' });
  const codex = runHook(root, { cwd: root, hook_event_name: 'SessionStart', source: 'compact', conversation_id: 'codex-conversation' });

  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(claude.stderr, '');
  assert.equal(codex.stderr, '');
  assert.deepEqual(JSON.parse(claude.stdout), JSON.parse(codex.stdout));
  const output = JSON.parse(codex.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof output.hookSpecificOutput.additionalContext, 'string');
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(currentRunId));
});

test('oversize and non-JSON stdin exit zero without injecting context', () => {
  const root = freshRoot();
  const oversized = Buffer.concat([Buffer.from('{}'), Buffer.alloc(1_048_577, 0x20)]);
  for (const input of [oversized, '{']) {
    const result = runHook(root, input);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'deep-loop: sessionstart restore hook failed\n');
  }
});
