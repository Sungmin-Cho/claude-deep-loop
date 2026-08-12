import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = process.argv[2];
if (!['claude', 'codex'].includes(runtime)) throw new Error('runtime must be claude or codex');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'deep-loop.mjs');
const project = mkdtempSync(join(tmpdir(), `deep-loop-standalone-${runtime}-`));
const isolatedHome = mkdtempSync(join(tmpdir(), `deep-loop-standalone-home-${runtime}-`));
mkdirSync(join(project, '.claude', 'worktrees', 'standalone'), { recursive: true });
const now = '2026-08-06T00:00:00.000Z';
const childEnv = {
  HOME: isolatedHome,
  LOCALAPPDATA: join(isolatedHome, '.localappdata'),
  PATH: '',
  SystemRoot: process.env.SystemRoot ?? '',
  TMPDIR: process.env.TMPDIR ?? '',
  USERPROFILE: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, '.config'),
  XDG_STATE_HOME: join(isolatedHome, '.state'),
};

function invoke(args, { input = null, label = args.join(' ') } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--project-root', project], {
    cwd: project, encoding: 'utf8', env: childEnv, input, maxBuffer: 2_097_152,
  });
  if (result.status !== 0) {
    throw new Error(`${label}: exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  const text = result.stdout.trim();
  return text === '' ? null : JSON.parse(text);
}

function removeOwnedUserState(path) {
  const canonical = (realpathSync.native || realpathSync)(path);
  const canonicalTmp = (realpathSync.native || realpathSync)(tmpdir());
  if (dirname(canonical) !== canonicalTmp
    || !basename(canonical).startsWith(`deep-loop-standalone-home-${runtime}-`)) {
    throw new Error('STANDALONE_USER_STATE_CLEANUP_UNSAFE');
  }
  rmSync(canonical, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

function runLifecycle() {
if (process.env.DEEP_LOOP_STANDALONE_TEST_FAIL_AFTER_HOME === '1') {
  throw new Error('STANDALONE_TEST_FAILURE_AFTER_HOME');
}
const detected = invoke(['detect-plugins']);
const detectedPlugins = Object.entries(detected)
  .filter(([, value]) => value === true || value?.present === true)
  .map(([name]) => name)
  .sort();
if (detectedPlugins.length !== 0) {
  throw new Error(`standalone detector found plugins: ${detectedPlugins.join(',')}`);
}
const initialized = invoke([
  'init-run', '--runtime', runtime, '--goal', 'standalone isolation',
  '--protocol', 'standalone', '--continuation', 'workstream-session', '--now', now,
]);
const runId = initialized.run_id;
const fence1 = ['--owner', runId, '--generation', '1', '--run-id', runId];
const adapter = invoke([
  'adapter', 'resolve', '--protocol', 'standalone', '--task', 'standalone isolation',
  '--tier', 'recommend', '--run-id', runId,
]);
if (adapter.guard?.ok !== true
  || adapter.dispatch.kind !== 'inline'
  || adapter.dispatch.role !== 'maker'
  || adapter.dispatch.explicit_fallback !== true
  || adapter.dispatch.skill !== null) {
  throw new Error('standalone inline dispatch descriptor was not consumable');
}
const workstream = invoke([
  'workstream', 'new', '--title', 'Standalone isolation', '--branch', `standalone-${runtime}`,
  '--worktree', '.claude/worktrees/standalone', '--now', now, ...fence1,
]).id;
const maker = invoke([
  'episode', 'new', '--plugin', 'standalone', '--role', 'maker', '--kind', 'implementation',
  '--point', 'implementation', '--workstream', workstream, '--now', now, ...fence1,
]).id;
invoke(['episode', 'record', '--id', maker, '--status', 'in_progress', '--now', now, ...fence1]);

const emitted = invoke([
  'checkpoint', 'emit', '--runtime', runtime, '--now', now, ...fence1,
]);
invoke([
  'checkpoint', 'observe', '--checkpoint', emitted.checkpoint_rel, '--trigger', 'auto',
  '--runtime', runtime, '--trusted-postcompact-stdin', '--json', '--now', now, ...fence1,
], {
  input: JSON.stringify({
    hook_event_name: 'PostCompact', cwd: realpathSync(project), trigger: 'auto',
  }),
  label: 'checkpoint observe',
});
invoke([
  'checkpoint', 'restore', '--checkpoint', emitted.checkpoint_rel, '--runtime', runtime,
  '--admission', 'postcompact-observation', '--source', 'sessionstart', '--json',
  '--now', now, ...fence1,
]);
invoke(['next-action', '--json', '--now', now, '--run-id', runId]);
invoke(['comprehension', 'status', '--run-id', runId]);
invoke(['comprehension', 'ack', '--episode', maker, '--actor', 'agent', '--now', now, ...fence1]);
invoke([
  'episode', 'abandon', '--id', maker, '--reason', 'standalone fixture terminal',
  '--confirm', '--now', now, ...fence1,
]);
invoke([
  'workstream', 'terminal', '--id', workstream, '--status', 'abandoned',
  '--proof', '{"reason":"standalone fixture terminal"}', '--confirm', '--now', now, ...fence1,
]);
const boundary = invoke(['next-action', '--json', '--now', now, '--run-id', runId]);
const boundaryIdentity = boundary.action.boundary_event;
const handoff = invoke([
  'handoff', 'emit', '--reason', 'workstream-terminal', '--trigger', 'workstream-terminal',
  '--boundary-event', boundaryIdentity, '--now', now, ...fence1,
]);
const resume = spawnSync(process.execPath, [
  CLI, 'resume-command', '--run-id', runId, '--project-root', project,
], { cwd: project, encoding: 'utf8', env: childEnv, maxBuffer: 2_097_152 });
if (resume.status !== 0 || resume.stdout.trim() === '') throw new Error(`resume-command: ${resume.stderr}`);
const boundaryAttemptId = 'STANDALONEATTEMPT01';
const acquired = invoke([
  'lease', 'acquire', '--owner', handoff.childRunId, '--generation', '1',
  '--runtime', runtime, '--attempt-id', boundaryAttemptId, '--now', now, '--run-id', runId,
]);
if (acquired.proceed !== true || acquired.generation !== 2) throw new Error('boundary recovery did not proceed');
const activated = invoke([
  'lease', 'activate', '--stored-token', '--owner', handoff.childRunId, '--generation', '2',
  '--runtime', runtime, '--attempt-id', boundaryAttemptId, '--now', now, '--run-id', runId,
]);
if (activated.ok !== true || !['activated', 'already-activated'].includes(activated.reason)) {
  throw new Error('boundary recovery did not activate');
}
invoke([
  'finish', '--status', 'stopped', '--proof', '{"human_reason":"standalone fixture complete"}',
  '--confirm', '--now', now, '--owner', handoff.childRunId, '--generation', '2', '--run-id', runId,
]);
const terminal = invoke(['state', 'get', '--run-id', runId]);

return {
  runtime,
  protocol: terminal.routing.protocol,
  orca_present: false,
  detected_plugins: detectedPlugins,
  terminal_escape: 'human-confirmed-abandon-without-independent-checker',
  stages: [
    'init', 'dispatch-inline', 'prepare', 'observe', 'restore', 'continue', 'status', 'ack',
    'terminal-boundary', 'handoff', 'resume', 'recovery', 'activation', 'finish',
  ],
  terminal_status: terminal.status,
  descriptor: {
    action: boundary.action,
    next_command: boundary.next_command,
    fence: { owner: runId, generation: 1 },
    boundary_identity: boundaryIdentity,
  },
};
}

let output;
try {
  output = runLifecycle();
} finally {
  removeOwnedUserState(isolatedHome);
}
output.user_state_cleaned = !existsSync(isolatedHome);
process.stdout.write(`${JSON.stringify(output)}\n`);
