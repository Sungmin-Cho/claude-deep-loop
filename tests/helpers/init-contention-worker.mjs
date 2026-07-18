import { productionInitDeps } from '../../scripts/lib/initrun.mjs';
import { commitPreparedInit, prepareInitialization } from '../../scripts/lib/init-transaction.mjs';

const [root, goal, attempt, mode = 'normal'] = process.argv.slice(2);
if (mode === 'exit-before-ready') process.exit(0);
if (mode === 'hang-before-ready') {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
const request = { runtime: 'codex', goal, protocol: 'standalone',
  recipe: { id: 'r', name: 'r', reason: 'test' }, review: null,
  detected: {}, git: {}, sessionSpawn: { launcher: 'none' }, model: null, effort: null,
  consent: { mode: 'manual', authority: 'default-manual' }, observationDigest: 'NONE',
  enumProfile: { kind: 'codex-cli', source: 'codex-cli-host', capabilities: [] } };
const deps = productionInitDeps(root, request, { ulid: () => attempt, pid: process.pid,
  nonce: () => String(process.pid).padStart(16, '0') });
const prepared = prepareInitialization(root, request, deps);
process.send({ type: 'ready', prepared }, () => {
  if (mode === 'exit-before-result') process.exit(0);
});
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
