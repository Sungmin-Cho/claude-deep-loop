import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRun } from '../scripts/lib/initrun.mjs';
import { runDir } from '../scripts/lib/state.mjs';

function runValidate(args = []) {
  try {
    execFileSync('node', ['scripts/deep-loop.mjs', 'validate', ...args], { encoding: 'utf8' });
    return 0;
  } catch (e) { return e.status ?? 1; }
}

const CLI = fileURLToPath(new URL('../scripts/deep-loop.mjs', import.meta.url));
function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('CLI init-run missing runtime exits 2 and creates no run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-runtime-cli-'));
  const result = runCli(['init-run', '--goal', 'g', '--project-root', root]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /runtime/i);
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});

test('CLI init-run invalid runtime exits 1 and creates no run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-runtime-cli-'));
  const result = runCli(['init-run', '--goal', 'g', '--runtime', 'other', '--project-root', root]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /INVALID_RUNTIME/);
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});

test('validate exits 0 with no run (schema+builder self-test)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  assert.equal(runValidate(['--project-root', root]), 0);
});

test('validate exits 0 for a freshly initialized run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'x', detected: {}, now: new Date() });
  assert.equal(runValidate(['--project-root', root, '--run-id', runId]), 0);
});

test('validate exits nonzero when loop.json is corrupted (hash anchor fires)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'x', detected: {}, now: new Date() });
  writeFileSync(join(runDir(root, runId), 'loop.json'), '{"goal":"hacked"}'); // hash mismatch
  assert.notEqual(runValidate(['--project-root', root, '--run-id', runId]), 0);
});

// ── impl-R3 🟡C + Phase6 ITEM-1: recipes/ledger fail-closed 검증은 런타임 라우팅이 실제로 읽는
// **플러그인 번들 recipesDir** 기준이다 (project-root 기준이 아님) — --project-root가 타 프로젝트를
// 가리켜도 그 프로젝트 자체의 recipes/*.json은 검사 대상이 아니다(false-failure 방지, validateRecipesDir
// 유닛 테스트는 tests/recipes.test.mjs가 주입 dir로 fail-closed 동작을 직접 검증한다).
test('validate exits 0 even when --project-root has its own malformed recipes/*.json (project-root recipes/ is not the validated dir)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, 'recipes'), { recursive: true });
  writeFileSync(join(root, 'recipes', 'broken.json'), '{oops');
  assert.equal(runValidate(['--project-root', root]), 0);
});
test('validate exits 0 even when a --project-root recipe lacks a triggers array (project-root recipes/ is not the validated dir)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, 'recipes'), { recursive: true });
  writeFileSync(join(root, 'recipes', 'not-a-recipe.json'), JSON.stringify({ id: 'x' }));
  assert.equal(runValidate(['--project-root', root]), 0);
});
test('validate exits 0 with valid recipes + array ledger under --project-root (irrelevant to validated dir, still harmless)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, 'recipes'), { recursive: true });
  writeFileSync(join(root, 'recipes', 'ok.json'), JSON.stringify({ id: 'ok', triggers: ['x'] }));
  writeFileSync(join(root, 'recipes', 'hillclimb-ledger.json'), '[]');
  assert.equal(runValidate(['--project-root', root]), 0);
});
// The bundled recipesDir itself (this repo's recipes/) must always validate clean, regardless of --project-root.
test('validate exits 0 for the bundled recipes/ dir (validated independent of --project-root)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  assert.equal(runValidate(['--project-root', root]), 0);
});

import { test as test7bCli } from 'node:test';
import assert7bCli from 'node:assert/strict';
import { mkdtempSync as temp7b, writeFileSync as write7b } from 'node:fs';
import { tmpdir as tmp7b } from 'node:os';
import { join as join7b } from 'node:path';
import { contentHash as hash7b } from '../scripts/lib/envelope.mjs';
import { appHostTaskCwdDigest as cwdDigest7b } from '../scripts/lib/host-surface.mjs';
import { initRun as init7b } from '../scripts/lib/initrun.mjs';
import {
  appendAnchored as append7b, directMutationOptions as directOptions7b,
} from '../scripts/lib/integrity.mjs';
import { readState as read7b } from '../scripts/lib/state.mjs';

function writeHashValidTamper7b(root, runId, loop) {
  const directory = join7b(root, '.deep-loop', 'runs', runId);
  const raw = JSON.stringify(loop, null, 2);
  write7b(join7b(directory, 'loop.json'), raw);
  write7b(join7b(directory, '.loop.hash'), hash7b(raw));
}

test7bCli('validate CLI rejects App event timestamp drift in a hash-valid run', () => {
  const root = temp7b(join7b(tmp7b(), 'dl-app-correlation-'));
  const { runId } = init7b(root, { runtime: 'codex', goal: 'g',
    now: new Date('2026-07-13T00:00:00.000Z'),
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context',
      observed_at: '2026-07-13T00:00:00.000Z' },
    cwdFn: () => root, appContinuationConsent: { mode: 'auto', authority: 'human-confirmed',
      confirmed_at: '2026-07-13T00:00:00.000Z', revoked_at: null } });
  const canonicalRoot = read7b(root, runId).data.project.root;
  const attempt = '01JAPPTASK0000000000000000';
  const childId = '01JAPPCHD00000000000000000';
  append7b(root, runId, { type: 'handoff-emitted',
    data: { attempt_id: attempt, child_run_id: childId } }, loop => {
    const parent = loop.session_chain.sessions.find(session =>
      session.run_id === loop.session_chain.lease.owner_run_id);
    parent.superseded_by = childId;
    loop.session_chain.sessions.push({ run_id: childId, started_at: null, ended_at: null,
      turns: 0, outcome: null, superseded_by: null, host_surface: null, continuation: {
        transport: 'codex-app', attempt_id: attempt, route: 'create', context_mode: 'fresh',
        phase: 'emitted', expected_runtime: 'codex', expected_host_surface: 'codex-app',
        target_cwd: canonicalRoot,
        host_task_cwd_digest: cwdDigest7b(parent.host_surface, canonicalRoot),
        workstream_id: null,
        project_id: null, descriptor_digest: null,
        emitted_at: '2026-07-13T00:00:01.000Z',
        prepare_deadline: '2026-07-13T00:05:01.000Z', prepared_at: null,
        confirmation_deadline: null, confirmed_at: null, acquired_at: null,
        acquired_generation: null, thread_id: null, unconfirmed_thread_id: null,
        failure_code: null, failure_binding: null,
      } });
    Object.assign(loop.session_chain.lease, { state: 'releasing', handoff_phase: 'emitted',
      handoff_transport: 'codex-app', handoff_attempt_id: attempt,
      handoff_child_run_id: childId, resume_policy: 'app' });
  }, undefined, directOptions7b('test-app-correlation-timestamp-drift',
    { owner: runId, generation: 1 }, { attempt, child_id: childId, canonical_root: canonicalRoot },
    'LEASE_FENCED: validate-fixture',
    { nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') }));
  const loop = read7b(root, runId).data;
  loop.session_chain.sessions.at(-1).continuation.emitted_at = '2026-07-13T00:00:02.000Z';
  writeHashValidTamper7b(root, runId, loop);
  const result = runCli(['validate', '--project-root', root, '--run-id', runId]);
  assert7bCli.notEqual(result.status, 0);
  assert7bCli.match(result.stderr, /App event correlation/);

  const stampRoot = temp7b(join7b(tmp7b(), 'dl-host-stamp-correlation-'));
  const stamped = init7b(stampRoot, { runtime: 'codex', goal: 'g',
    now: new Date('2026-07-13T00:00:00.000Z'),
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: stampRoot,
      host_task_cwd_source: 'app-task-context',
      observed_at: '2026-07-13T00:00:00.000Z' }, cwdFn: () => stampRoot });
  const stampOnly = read7b(stampRoot, stamped.runId).data;
  stampOnly.session_chain.lease.generation = 2;
  stampOnly.session_chain.sessions[0].host_surface.observed_generation = 2;
  stampOnly.session_chain.sessions[0].host_surface.observed_at =
    '2026-07-13T00:00:02.000Z';
  writeHashValidTamper7b(stampRoot, stamped.runId, stampOnly);
  const stampResult = runCli(['validate', '--project-root', stampRoot,
    '--run-id', stamped.runId]);
  assert7bCli.notEqual(stampResult.status, 0);
  assert7bCli.match(stampResult.stderr, /App event correlation/,
    'current-generation stamp without its anchored observation event is invalid');
});
