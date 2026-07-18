import { buildFixedInitializationRequest, commitFixedInitialization,
  productionInitDeps } from '../../scripts/lib/initrun.mjs';

const [root, attempt, previous, requestDigest, observationDigest, authorityJson, profile, crashMode]
  = process.argv.slice(2);
if (!['enum', 'full'].includes(profile)
    || !['after-commit', 'inside-lock'].includes(crashMode)) process.exit(64);
let preparedAuthority;
try { preparedAuthority = JSON.parse(authorityJson); } catch { process.exit(64); }
const observation = profile === 'full' ? { runtime: 'codex', kind: 'codex-app',
  source: 'codex-app-tool-provenance',
  capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
  structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: root,
  host_task_cwd_source: 'app-task-context', observed_at: null } : null;
const request = buildFixedInitializationRequest({ root, runtime: 'codex', goal: 'response-loss',
  protocol: 'standalone', recipe: 'default', model: null, effort: null,
  consentMode: 'manual', consentAuthority: 'default-manual', observationDigest,
  enumProfile: profile === 'enum'
    ? { kind: 'codex-cli', source: 'codex-cli-host', capabilities: [] } : null });
const prepared = { ok: true, outcome: 'prepared', attempt_id: attempt,
  previous_current_digest: previous, expected_request_digest: requestDigest,
  expected_observation_digest: observationDigest, prepared_authority: preparedAuthority };
if (crashMode === 'inside-lock') {
  process.env.NODE_ENV = 'test';
  process.env.DEEP_LOOP_TEST_CRASH_AT = 'current-after-rename';
}
const deps = productionInitDeps(root, request, {
  pid: process.pid, nonce: () => String(process.pid).padStart(16, '0'),
});
commitFixedInitialization(root, { request, observation, prepared }, deps);
if (crashMode === 'after-commit') process.exit(91);
process.exit(70);
