import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRun } from '../scripts/lib/initrun.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { buildRuntimeResumeDescriptor } from '../scripts/lib/runtime-descriptor.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { advanceHandoffPhase, reserveHandoff } from '../scripts/lib/lease.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'scripts', 'deep-loop.mjs');
const NOW = new Date('2026-07-20T00:00:00.000Z');
const HANDOFF_NOW = Date.parse('2026-07-20T01:00:00.000Z');

function freshRoot(prefix = 'dl-resume-command-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seed(runtime = 'claude') {
  const root = freshRoot();
  const { runId } = initRun(root, {
    runtime,
    goal: 'resume command contract',
    detected: {},
    now: NOW,
    env: {},
    platform: process.platform,
    run: () => ({ code: 1 }),
  });
  migrateAuthenticLegacyTransport(root, runId);
  return { root, runId };
}

function invoke(args, { cwd = REPO_ROOT } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function stateBytes(root, runId) {
  const dir = runDir(root, runId);
  return {
    loop: readFileSync(join(dir, 'loop.json')),
    hash: readFileSync(join(dir, '.loop.hash')),
  };
}

function assertStateBytesEqual(root, runId, before) {
  const after = stateBytes(root, runId);
  assert.deepEqual(after.loop, before.loop, 'resume-command must not rewrite loop.json');
  assert.deepEqual(after.hash, before.hash, 'resume-command must not rewrite .loop.hash');
}

function descriptorForPending(root, runId) {
  const { data } = readState(root, runId);
  const lease = data.session_chain.lease;
  const child = data.session_chain.sessions.find(session => session.run_id === lease.handoff_child_run_id);
  assert.ok(child?.handoff_rel, 'emitted handoff must expose its canonical artifact path');
  return buildRuntimeResumeDescriptor({
    runtime: data.autonomy.session_runtime,
    root: data.project.root,
    parentRunId: runId,
    childRunId: lease.handoff_child_run_id,
    handoffRel: child.handoff_rel,
  });
}

for (const runtime of ['claude', 'codex']) {
  test(`resume-command prints the byte-exact ${runtime} descriptor invocation and is read-only`, () => {
    const { root, runId } = seed(runtime);
    const emitted = emitHandoff(root, runId, {
      reason: 'manual fallback',
      trigger: 'resume-command-test',
      now: HANDOFF_NOW,
      expect: { owner: runId, generation: 1 },
      env: {},
    });
    assert.equal(emitted.ok, true);

    const descriptor = descriptorForPending(root, runId);
    const launchCommand = readFileSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'), 'utf8');
    const before = stateBytes(root, runId);
    const foreignCwd = freshRoot('dl-resume-command-cwd-');
    const result = invoke([
      'resume-command', '--project-root', root, '--run-id', runId,
    ], { cwd: foreignCwd });

    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(lines[0], descriptor.resumeInvocation);
    assert.equal(lines[0].includes(emitted.childRunId), false, 'resume binds the logical parent run, never the child owner');
    assert.ok(result.stdout.includes(`child_run_id=${emitted.childRunId}`), 'child id belongs in the lease/handoff summary');
    assert.ok(result.stdout.includes(`handoff_phase=emitted`));
    assert.ok(!result.stdout.includes(launchCommand.trimEnd()), 'legacy launch text without bound metadata must be ignored');
    assert.ok(result.stdout.includes(`Launcher guidance: ${descriptor.entries.interactive.display}`));
    assert.match(result.stdout, /인수 확인은 \/deep-loop-status/);
    assertStateBytesEqual(root, runId, before);

    const handoff = readFileSync(emitted.handoffPath, 'utf8').split('\n');
    assert.equal(handoff[0], `Resume command: ${descriptor.resumeInvocation}`);
    assert.equal(handoff[1], `Lease: owner=${runId} handoff_phase=reserved child_run_id=${emitted.childRunId}`);
    assert.equal(handoff[2], 'Status: 인수 확인은 /deep-loop-status');
  });
}

test('resume-command reports no pending handoff without calling the descriptor builder or writing state', () => {
  const { root, runId } = seed();
  const before = stateBytes(root, runId);
  const result = invoke(['resume-command', '--project-root', root, '--run-id', runId]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no pending handoff/i);
  assertStateBytesEqual(root, runId, before);
});

test('resume-command rejects value-less root and run-id options as usage before root resolution', () => {
  const { root, runId } = seed();
  const before = stateBytes(root, runId);
  const foreignCwd = freshRoot('dl-resume-command-usage-cwd-');

  const rootMissingValue = invoke(['resume-command', '--project-root'], { cwd: foreignCwd });
  assert.equal(rootMissingValue.status, 2, rootMissingValue.stderr);
  assert.match(rootMissingValue.stderr, /USAGE:.*--project-root.*value/i);

  const runIdMissingValue = invoke(['resume-command', '--project-root', root, '--run-id'], { cwd: foreignCwd });
  assert.equal(runIdMissingValue.status, 2, runIdMissingValue.stderr);
  assert.match(runIdMissingValue.stderr, /USAGE:.*--run-id.*value/i);
  assertStateBytesEqual(root, runId, before);
});

test('resume-command without an explicit or current run id is a usage error', () => {
  const emptyRoot = freshRoot('dl-resume-command-empty-');
  const result = invoke(['resume-command', '--project-root', emptyRoot]);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /MISSING_RUN_ID|USAGE:.*run-id/i);
});

test('resume-command classifies a copied run with a live stored root as PROJECT_ROOT_FENCED exit 3', () => {
  const { root, runId } = seed();
  emitHandoff(root, runId, {
    reason: 'fenced copy', trigger: 'resume-command-fenced', now: HANDOFF_NOW,
    expect: { owner: runId, generation: 1 }, env: {},
  });
  const candidateRoot = freshRoot('dl-resume-command-fenced-copy-');
  cpSync(join(root, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });

  const result = invoke(['resume-command', '--project-root', candidateRoot, '--run-id', runId]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /PROJECT_ROOT_FENCED/);
});

test('resume-command falls back to the process-platform descriptor when launch-command.txt is absent', () => {
  const { root, runId } = seed('claude');
  emitHandoff(root, runId, {
    reason: 'missing launch artifact', trigger: 'resume-command-fallback', now: HANDOFF_NOW,
    expect: { owner: runId, generation: 1 }, env: {},
  });
  const { data } = readState(root, runId);
  data.session_spawn.platform = process.platform === 'win32' ? 'darwin' : 'win32';
  writeState(root, runId, data);
  rmSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'));
  const expected = descriptorForPending(root, runId);

  const result = invoke(['resume-command', '--project-root', root, '--run-id', runId]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes(`Launcher guidance: ${expected.entries.interactive.display}`),
    'fallback descriptor must describe the executing process platform, not the stored detection platform',
  );
});

test('resume-command ignores stale or mismatched launch metadata and never trusts text existence alone', () => {
  const { root, runId } = seed('claude');
  emitHandoff(root, runId, {
    reason: 'stale metadata', trigger: 'resume-command-stale-meta', now: HANDOFF_NOW,
    expect: { owner: runId, generation: 1 }, env: {},
  });
  const dir = runDir(root, runId);
  const textPath = join(dir, 'terminal', 'launch-command.txt');
  const metaPath = join(dir, 'terminal', 'launch-command.meta.json');
  writeFileSync(textPath, 'STALE-LAUNCH-TEXT\n');
  writeFileSync(metaPath, JSON.stringify({
    launch_command_sha256: contentHash(Buffer.from('different bytes')),
    parent_run_id: runId,
    child_run_id: readState(root, runId).data.session_chain.lease.handoff_child_run_id,
    handoff_phase: 'emitted',
    project_root_digest: '0'.repeat(64),
    project_binding_generation: 0,
  }));
  const expected = descriptorForPending(root, runId);
  const result = invoke(['resume-command', '--project-root', root, '--run-id', runId]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /STALE-LAUNCH-TEXT/);
  assert.ok(result.stdout.includes(`Launcher guidance: ${expected.entries.interactive.display}`));
});

test('resume-command accepts both reserved and spawned pending phases', () => {
  for (const phase of ['reserved', 'spawned']) {
    const { root, runId } = seed();
    const reservation = reserveHandoff(root, runId, {
      trigger: `resume-command-${phase}`, now: HANDOFF_NOW,
      expect: { owner: runId, generation: 1 },
    });
    if (phase === 'spawned') {
      assert.equal(advanceHandoffPhase(root, runId, {
        key: reservation.key, toPhase: 'emitted', now: HANDOFF_NOW,
        expect: { owner: runId, generation: 1 },
      }).ok, true);
      assert.equal(advanceHandoffPhase(root, runId, {
        key: reservation.key, toPhase: 'spawned', now: HANDOFF_NOW + 1,
        expect: { owner: runId, generation: 1 },
      }).ok, true);
    }

    const result = invoke(['resume-command', '--project-root', root, '--run-id', runId]);
    assert.equal(result.status, 0, `${phase}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`handoff_phase=${phase}`));
    assert.match(result.stdout, /deep-loop-resume/);
  }
});

test('resume-command omits lease_state when the legacy summary value is not a string', () => {
  const { root, runId } = seed();
  emitHandoff(root, runId, {
    reason: 'legacy summary', trigger: 'resume-command-legacy-summary', now: HANDOFF_NOW,
    expect: { owner: runId, generation: 1 }, env: {},
  });
  const dir = runDir(root, runId);
  const loopPath = join(dir, 'loop.json');
  const raw = JSON.parse(readFileSync(loopPath, 'utf8'));
  delete raw.session_chain.lease.state;
  const rawText = JSON.stringify(raw, null, 2);
  writeFileSync(loopPath, rawText);
  writeFileSync(join(dir, '.loop.hash'), contentHash(rawText));

  const result = invoke(['resume-command', '--project-root', root, '--run-id', runId]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /lease_state=/);
  assert.doesNotMatch(result.stdout, /undefined/);
});
