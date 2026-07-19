import { emitHandoff } from '../../scripts/lib/handoff.mjs';
import { respawnGate } from '../../scripts/lib/respawn.mjs';
import { runPreCompactHandoff } from '../../scripts/hooks-impl/precompact-handoff.mjs';

const [root, mode, nowText] = process.argv.slice(2);
if (!['emit', 'pause', 'rollback'].includes(mode)
    || !/^\d+$/.test(nowText || '')
    || !process.env.DEEP_LOOP_TEST_CRASH_AT) {
  throw new Error('PRECOMPACT_CRASH_INPUT_INVALID');
}
const point = process.env.DEEP_LOOP_TEST_CRASH_AT;
process.env.NODE_ENV = 'test';
const deps = { root, now: Number(nowText), env: {}, cwdFn: () => root };
if (mode !== 'emit') {
  deps.emitFn = (emitRoot, runId, options) => {
    delete process.env.DEEP_LOOP_TEST_CRASH_AT;
    const result = emitHandoff(emitRoot, runId, options);
    if (mode === 'pause') process.env.DEEP_LOOP_TEST_CRASH_AT = point;
    return result;
  };
}
if (mode === 'rollback') {
  deps.gateFn = (loop, options) => {
    const result = respawnGate(loop, options);
    process.env.DEEP_LOOP_TEST_CRASH_AT = point;
    return result;
  };
}
await runPreCompactHandoff({ unattended: true }, deps);
throw new Error('PRECOMPACT_CRASH_POINT_NOT_REACHED');
