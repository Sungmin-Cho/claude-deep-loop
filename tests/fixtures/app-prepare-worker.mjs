import { existsSync, writeFileSync } from 'node:fs';
import { prepareAppTask } from '../../scripts/lib/app-task-continuation.mjs';

const [root, runId, gateFile, readyFile, mode, barrierReady, barrierRelease] = process.argv.slice(2);
writeFileSync(readyFile, 'ready', { flag: 'wx' });
while (!existsSync(gateFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const projectId = 'project $`\\';
try {
  const result = prepareAppTask(root, runId, { owner: runId, generation: 1,
    stdinMode: 'pty-raw-noecho', hostInput: { currentHostTaskCwd: root,
      projects: [{ projectId, projectKind: 'local', path: root }] } }, {
    cwdFn: () => root, nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
    descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project', projectId,
      environment: { type: 'local' } }, prompt: 'prompt' }),
    reconcileBudgetFn: () => {
      if (mode !== 'barrier-valid') return;
      writeFileSync(barrierReady, 'ready', { flag: 'wx' });
      while (!existsSync(barrierRelease)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    },
    gateFn: () => ({ ok: true, blocked_by: [] }),
  });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ worker_error: String(error?.message || error) }));
}
