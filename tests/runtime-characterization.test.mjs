import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resumeSkillToken, usageOutputKind } from '../scripts/lib/runtime-descriptor.mjs';
import { isHeadlessInvocation } from '../scripts/lib/respawn.mjs';
import { validateRuntimeProfile } from '../scripts/lib/session-profile.mjs';
import {
  collectRuntimeExecutableCandidates,
  resolveTrustedRuntimeExecutable,
} from '../scripts/lib/runtime-executable.mjs';
import {
  emitCompactCheckpoint,
  inspectCompactForSessionStart,
  restoreCompactCheckpoint,
} from '../scripts/lib/checkpoint.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream, setWorkstreamStatus } from '../scripts/lib/workspace.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');

function seed(runtime = 'claude', { label = runtime, now = '2026-08-05T00:00:00.000Z' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `dl-runtime-char-${runtime}-`)));
  const { runId } = initRun(root, {
    runtime,
    goal: 'runtime characterization',
    now: new Date(now),
  });
  const fence = { owner: runId, generation: 1 };
  const worktree = `.claude/worktrees/char-${label}`;
  const containedCwd = join(root, worktree, 'src');
  mkdirSync(containedCwd, { recursive: true });
  const workstreamId = newWorkstream(root, runId, {
    title: `char-${label}`,
    branch: `feature/char-${label}`,
    worktree,
    fence,
  }).id;
  setWorkstreamStatus(root, runId, workstreamId, 'in_progress', { fence });
  const episodeId = newEpisode(root, runId, {
    plugin: 'deep-work',
    role: 'maker',
    kind: 'implementation',
    point: 'implementation',
    workstream: workstreamId,
    expectedArtifacts: [],
    fence,
  }).id;
  recordEpisode(root, runId, episodeId, { status: 'in_progress', fence });
  return { root, runId, runtime, fence, containedCwd };
}

test('CHARACTERIZATION codex rejects max effort, claude accepts it', () => {
  assert.throws(() => validateRuntimeProfile('codex', { effort: 'max' }), /UNSUPPORTED_RUNTIME_EFFORT/);
  assert.deepEqual(validateRuntimeProfile('claude', { effort: 'max' }), { model: null, effort: 'max' });
});

test('CHARACTERIZATION entrypoint heuristic applies to claude only', () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: 'sdk-py' };
  assert.equal(isHeadlessInvocation(env, 'claude'), true);
  assert.equal(isHeadlessInvocation(env, 'codex'), false);
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'claude'), false);
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_HEADLESS: '1' }, 'codex'), true);
});

test('CHARACTERIZATION resumeSkillToken current mapping', () => {
  assert.equal(resumeSkillToken('claude'), '/deep-loop-resume');
  assert.equal(resumeSkillToken('codex'), '$deep-loop:deep-loop-resume');
  assert.equal(resumeSkillToken(), '/deep-loop-resume');
});

test('CHARACTERIZATION usageOutputKind current mapping', () => {
  assert.equal(usageOutputKind('claude'), 'claude-json');
  assert.equal(usageOutputKind('codex'), 'codex-jsonl');
  assert.equal(usageOutputKind(), 'claude-json');
});

test('CHARACTERIZATION claude PATH candidate collection uses the claude name', () => {
  const bin = mkdtempSync(join(tmpdir(), 'dl-path-claude-'));
  writeFileSync(join(bin, 'claude'), '');
  writeFileSync(join(bin, 'codex'), '');
  const candidates = collectRuntimeExecutableCandidates('claude', {
    platform: 'linux', env: { PATH: bin },
  });
  assert.deepEqual(candidates.map(c => c.path), [join(bin, 'claude')]);
});

test('CHARACTERIZATION codex PATH candidate collection uses the codex name', () => {
  const bin = mkdtempSync(join(tmpdir(), 'dl-path-codex-'));
  writeFileSync(join(bin, 'claude'), '');
  writeFileSync(join(bin, 'codex'), '');
  const candidates = collectRuntimeExecutableCandidates('codex', {
    platform: 'linux', env: { PATH: bin },
  });
  assert.deepEqual(candidates.map(c => c.path), [join(bin, 'codex')]);
});

test('CHARACTERIZATION claude has no automatic native trust resolution', () => {
  assert.throws(
    () => resolveTrustedRuntimeExecutable('claude', { explicitPath: '/nonexistent/claude' }),
    /RUNTIME_EXECUTABLE_UNTRUSTED/,
  );
});

test('CHARACTERIZATION inspectLocked id-only evidence inherits provider from context runtime', () => {
  const claude = seed('claude', { label: 'inspect-claude' });
  emitCompactCheckpoint(claude.root, claude.runId, {
    fence: claude.fence,
    runtime: 'claude',
    hostSessionEvidence: { provider: 'claude-code', id: 'session-a' },
    now: Date.parse('2026-08-05T00:00:01.000Z'),
  });
  const claudeInspected = inspectCompactForSessionStart(claude.root, claude.runId, {
    hostSessionEvidence: { id: 'session-a' },
    now: Date.parse('2026-08-05T00:00:01.000Z'),
  });
  assert.equal(claudeInspected.ok, true);
  assert.deepEqual(claudeInspected.provider_evidence, {
    recorded: true, supplied: true, matched: true,
  });

  const codex = seed('codex', { label: 'inspect-codex' });
  emitCompactCheckpoint(codex.root, codex.runId, {
    fence: codex.fence,
    runtime: 'codex',
    hostSessionEvidence: { provider: 'codex', id: 'session-a' },
    now: Date.parse('2026-08-05T00:00:01.000Z'),
  });
  const codexInspected = inspectCompactForSessionStart(codex.root, codex.runId, {
    hostSessionEvidence: { id: 'session-a' },
    now: Date.parse('2026-08-05T00:00:01.000Z'),
  });
  assert.equal(codexInspected.ok, true);
  assert.deepEqual(codexInspected.provider_evidence, {
    recorded: true, supplied: true, matched: true,
  });
});

test('CHARACTERIZATION checkpoint restore treats Claude entrypoint print as headless', () => {
  const fixture = seed('claude', { label: 'restore-print' });
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: 'claude',
    now: Date.parse('2026-08-05T00:00:01.000Z'),
  });
  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: 'claude',
    admission: 'human-attested',
    source: 'direct-human-skill',
    confirmManualCompact: true,
    env: { CLAUDE_CODE_ENTRYPOINT: 'print' },
    now: Date.parse('2026-08-05T00:00:02.000Z'),
  }), /CHECKPOINT_MANUAL_ATTESTATION_REQUIRED/);
});

test('CHARACTERIZATION checkpoint restore ignores Claude entrypoint for codex', () => {
  const fixture = seed('codex', { label: 'restore-codex' });
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: 'codex',
    now: Date.parse('2026-08-05T00:00:01.000Z'),
  });
  const restored = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: 'codex',
    admission: 'human-attested',
    source: 'direct-human-skill',
    confirmManualCompact: true,
    env: { CLAUDE_CODE_ENTRYPOINT: 'print' },
    now: Date.parse('2026-08-05T00:00:02.000Z'),
  });
  assert.equal(restored.ok, true);
});

test('CHARACTERIZATION checkpoint observe CLI labels claude provider as claude-code', () => {
  const fixture = seed('claude', { label: 'observe-claude' });
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: 'claude',
    hostSessionEvidence: { provider: 'claude-code', id: 'cli-session' },
    now: Date.parse('2026-08-05T00:00:01.000Z'),
  });
  const result = spawnSync(process.execPath, [
    CLI,
    'checkpoint', 'observe',
    '--checkpoint', emitted.checkpoint_rel,
    '--trigger', 'manual',
    '--owner', fixture.fence.owner,
    '--generation', String(fixture.fence.generation),
    '--runtime', 'claude',
    '--json',
    '--trusted-postcompact-stdin',
    '--project-root', fixture.root,
    '--run-id', fixture.runId,
  ], {
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'PostCompact',
      cwd: fixture.containedCwd,
      trigger: 'manual',
      session_id: 'cli-session',
    }),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout).provider_evidence, {
    recorded: true, supplied: true, matched: true,
  });
});

test('CHARACTERIZATION checkpoint observe CLI labels codex provider as codex', () => {
  const fixture = seed('codex', { label: 'observe-codex' });
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: 'codex',
    hostSessionEvidence: { provider: 'codex', id: 'cli-session' },
    now: Date.parse('2026-08-05T00:00:01.000Z'),
  });
  const result = spawnSync(process.execPath, [
    CLI,
    'checkpoint', 'observe',
    '--checkpoint', emitted.checkpoint_rel,
    '--trigger', 'manual',
    '--owner', fixture.fence.owner,
    '--generation', String(fixture.fence.generation),
    '--runtime', 'codex',
    '--json',
    '--trusted-postcompact-stdin',
    '--project-root', fixture.root,
    '--run-id', fixture.runId,
  ], {
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'PostCompact',
      cwd: fixture.containedCwd,
      trigger: 'manual',
      session_id: 'cli-session',
    }),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout).provider_evidence, {
    recorded: true, supplied: true, matched: true,
  });
});
