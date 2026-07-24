import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from '../../scripts/lib/envelope.mjs';
import { readState, runDir } from '../../scripts/lib/state.mjs';

export function migrateAuthenticLegacyTransport(root, runId, policy = 'compact-in-place') {
  if (!['compact-in-place', 'rotate-per-unit'].includes(policy)) {
    throw new Error(`legacy transport policy required, got ${policy}`);
  }
  const dir = runDir(root, runId);
  const loopPath = join(dir, 'loop.json');
  const legacy = JSON.parse(readFileSync(loopPath, 'utf8'));
  legacy.schema_version = '0.3.0';
  delete legacy.project.binding_generation;
  delete legacy.autonomy.attended_launch_approval;
  delete legacy.session_chain.lease.takeover_kind;
  legacy.autonomy.continuation_policy = policy;
  legacy.autonomy.milestone_predicate = ['workstream_status_change'];
  for (const session of legacy.session_chain.sessions) delete session.scope;
  const raw = JSON.stringify(legacy, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
  const migrated = readState(root, runId).data;
  if (migrated.schema_version !== '0.4.0'
    || migrated.autonomy.continuation_policy !== policy
    || migrated.session_chain.sessions.some(session => session.scope?.kind !== 'legacy')) {
    throw new Error('legacy transport fixture did not migrate authentically');
  }
  return migrated;
}
