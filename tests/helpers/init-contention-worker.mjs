import { buildInitialLoop, productionInitDeps } from '../../scripts/lib/initrun.mjs';
import { commitPreparedInit, prepareInitialization } from '../../scripts/lib/init-transaction.mjs';

const [root, goal, attempt] = process.argv.slice(2);
const request = { runtime: 'codex', goal, protocol: 'standalone',
  recipe: { id: 'r', name: 'r', reason: 'test' }, review: null,
  detected: {}, git: {}, sessionSpawn: { launcher: 'none' }, model: null, effort: null,
  consent: { mode: 'manual', authority: 'default-manual' }, observationDigest: 'NONE',
  enumProfile: { kind: 'codex-cli', source: 'codex-cli-host', capabilities: [] } };
const deps = productionInitDeps(root, request, { buildLoop: buildInitialLoop,
  ulid: () => attempt, pid: process.pid,
  nonce: () => String(process.pid).padStart(16, '0') });
const prepared = prepareInitialization(root, request, deps);
process.send({ type: 'ready', prepared });
process.once('message', message => {
  if (message?.type !== 'commit') process.exit(70);
  try {
    const result = commitPreparedInit(root, { prepared, request, observation: null }, deps);
    process.send({ type: 'result', ok: true, result });
  } catch (error) {
    process.send({ type: 'result', ok: false, code: String(error.message) });
  }
  process.disconnect();
});
