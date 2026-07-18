export const DEFAULT_APP_TASK_CONTINUATION = Object.freeze({
  mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null,
});

const COMPLETE_CREATE = ['list-projects', 'create-thread-local', 'structured-process-stdin'];
const COMPLETE_FORK = [
  'fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin',
];

export function validateGenesisConsent({ runtime, route, observation, consent }) {
  const manual = consent?.mode === 'manual' && consent?.authority === 'default-manual'
    && consent.confirmed_at === null && consent.revoked_at === null;
  if (manual) return consent;
  const capabilities = new Set(observation?.capabilities ?? []);
  const complete = route === 'create'
    ? COMPLETE_CREATE.every(value => capabilities.has(value))
    : route === 'fork' && COMPLETE_FORK.every(value => capabilities.has(value));
  const auto = consent?.mode === 'auto' && consent?.authority === 'human-confirmed'
    && typeof consent.confirmed_at === 'string' && consent.revoked_at === null;
  if (!auto || runtime !== 'codex' || observation?.kind !== 'codex-app'
      || !['codex-app-host-context', 'codex-app-tool-provenance'].includes(observation.source)
      || observation.host_task_cwd_source !== 'app-task-context'
      || observation.host_task_cwd !== observation.kernel_cwd_at_observation
      || observation.observed_generation !== 1
      || !['pipe-open-noecho', 'pty-raw-noecho'].includes(observation.structured_stdin_mode)
      || !complete) throw new Error('APP_CONSENT_INVALID');
  return consent;
}
