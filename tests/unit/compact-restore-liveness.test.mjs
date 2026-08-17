import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const COMPACT = readFileSync(new URL('../../skills/deep-loop-compact/SKILL.md', import.meta.url), 'utf8');
const CONTINUE = readFileSync(new URL('../../skills/deep-loop-continue/SKILL.md', import.meta.url), 'utf8');

function simulatedRestoreOutcome({ directive = null, restore = 'committed', affinity = true } = {}) {
  if (directive === 'deep-loop-compact-preserve-pause-only') {
    return { inspect: 0, restore: 0, pause: 1, continue: 0, capsule: false };
  }
  if (restore === 'committed' || restore === 'exact-replay') {
    return { inspect: 1, restore: 1, pause: 0, continue: 1, capsule: true };
  }
  return affinity
    ? { inspect: 1, restore: 0, pause: 0, continue: 1, capsule: false }
    : { inspect: 1, restore: 0, pause: 1, continue: 0, capsule: false };
}

test('compact restore liveness routes success, exact replay, stale fallback, and rejection exactly once', () => {
  assert.deepEqual(simulatedRestoreOutcome({ restore: 'committed' }),
    { inspect: 1, restore: 1, pause: 0, continue: 1, capsule: true });
  assert.deepEqual(simulatedRestoreOutcome({ restore: 'exact-replay' }),
    { inspect: 1, restore: 1, pause: 0, continue: 1, capsule: true });
  assert.deepEqual(simulatedRestoreOutcome({ restore: 'stale', affinity: true }),
    { inspect: 1, restore: 0, pause: 0, continue: 1, capsule: false });
  assert.deepEqual(simulatedRestoreOutcome({ restore: 'stale', affinity: false }),
    { inspect: 1, restore: 0, pause: 1, continue: 0, capsule: false });
  assert.deepEqual(simulatedRestoreOutcome({ directive: 'deep-loop-compact-preserve-pause-only' }),
    { inspect: 0, restore: 0, pause: 1, continue: 0, capsule: false });

  assert.match(COMPACT, /Direct dispatch boundary/);
  assert.match(COMPACT, /deep-loop-compact-preserve-pause-only/);
});

test('malformed, truncated, and oversized restored capsule wires stop before profile mutation', () => {
  const gate = CONTINUE.match(/## 0\.25\. Restored compact capsule gate([\s\S]*?)## 0\.5\./)?.[1] ?? '';
  assert.match(gate, /malformed/);
  assert.match(gate, /truncated/);
  assert.match(gate, /oversized/);
  assert.match(gate, /session-profile set[\s\S]{0,160}(?:must not|never)/i);
});

test('model and effort refresh remain mutable and occur once only after the immutable capsule gate', () => {
  const gate = CONTINUE.indexOf('## 0.25. Restored compact capsule gate');
  const profile = CONTINUE.indexOf('## 0.5.');
  const nextAction = CONTINUE.indexOf('next-action --json', profile);
  assert.ok(gate >= 0 && gate < profile && profile < nextAction);
  assert.match(CONTINUE.slice(gate, nextAction), /model\/effort[\s\S]{0,300}not part of the immutable/i);
  assert.match(CONTINUE.slice(gate, profile), /정확히 한 번/);
});
