import { emitHandoff } from '../../scripts/lib/handoff.mjs';

const [root, runId] = process.argv.slice(2);
const exitAt = process.env.DEEP_LOOP_TEST_EXIT_AT;

emitHandoff(root, runId, {
  reason: 'milestone',
  trigger: 'milestone',
  now: Date.parse('2026-07-20T00:00:00.000Z'),
  headless: false,
  expect: { owner: runId, generation: 1 },
  env: {},
  onBoundary(name) {
    if (name === exitAt) process.exit(137);
  },
});
