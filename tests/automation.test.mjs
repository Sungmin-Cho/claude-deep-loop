import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { respawn } from '../scripts/lib/respawn.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { driveHeadless } from '../scripts/hooks-impl/drive-headless.mjs';

const A = join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes', 'automation');
function seedRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('driveHeadless drives when spawn ok and requests metric output', () => {
  let cmd = null;
  const r = driveHeadless({ root: seedRun().root, spawnFn: (c) => { cmd = c; return { ok: true, usage: { num_turns: 1, tokens: 50 } }; } });
  assert.equal(r.action, 'drove');
  assert.match(cmd, /--output-format json/);   // Codex r6 sf-4
});

// Codex r5 critical-2: 성공한 headless 실행의 측정 usage 는 budget+session 에 결정론적으로 커밋되어야 한다.
test('driveHeadless commits measured usage to budget on success', () => {
  const { root, runId } = seedRun();
  const r = driveHeadless({ root, spawnFn: () => ({ ok: true, usage: { num_turns: 3, tokens: 100 } }) });
  assert.equal(r.recorded, true);
  const d = readState(root, runId).data;
  assert.equal(d.budget.spent, 3);
  assert.equal(d.budget.tokens_spent, 100);
  assert.equal(d.session_chain.sessions[0].turns, 3);   // per_session_turn_cap 도 구동
});

// Codex r6 sf-2: 자식 tick 이 milestone 에서 handoff 를 emit 해 lease 가 releasing 이 돼도 측정 usage 는 정확히 1회 회계.
test('driveHeadless still accounts usage when the child emitted a handoff', () => {
  const { root, runId } = seedRun();
  const r = driveHeadless({ root, spawnFn: () => {
    emitHandoff(root, runId, { reason: 'milestone', trigger: 'milestone', expect: { owner: runId, generation: 1 } });  // lease → releasing
    return { ok: true, usage: { num_turns: 2, tokens: 50 } };
  } });
  assert.equal(r.recorded, true);
  assert.equal(readState(root, runId).data.budget.spent, 2);
});

// Codex r7 sf-2: 자식이 generation+1 로 완전히 인수했으면 stale 부모(캡처한 generation)는 펜싱돼 기록하지 않는다.
test('driveHeadless does not record under a child that fully acquired the lease', () => {
  const { root, runId } = seedRun();
  const spawnNow = Date.parse('2026-06-24T00:00:01Z');   // wallclock 창 안 — gate 차단 방지
  const r = driveHeadless({ root, spawnFn: () => {
    const em = emitHandoff(root, runId, { reason: 'milestone', trigger: 'milestone', expect: { owner: runId, generation: 1 }, now: spawnNow });
    respawn(root, runId, { childRunId: em.childRunId, key: em.key, handoffRel: em.handoffRel, headless: true, now: spawnNow, spawnFn: () => ({ ok: true }) });  // lease → released
    acquireLease(root, runId, { owner: em.childRunId, expectGeneration: 1, now: spawnNow });   // 자식 인수 → generation 2, owner=child
    return { ok: true, usage: { num_turns: 4 } };
  } });
  assert.equal(r.recorded, false);                              // 캡처한 부모 fence(gen 1) 가 펜싱됨
  assert.equal(readState(root, runId).data.budget.spent, 0);    // 부모는 기록 안 함
});

test('driveHeadless fails closed when usage unmeasurable/timeout', () => {
  const r = driveHeadless({ root: seedRun().root, spawnFn: () => ({ ok: false, reason: 'unmeasurable-fail-closed' }) });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fail-closed');
});

test('driveHeadless is a no-op when no current run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto0-'));
  assert.equal(driveHeadless({ root }).action, 'no-run');
});

test('cron template calls the fail-closed driver (not raw claude -p)', () => {
  const f = join(A, 'cron-morning-triage.yml'); assert.ok(existsSync(f));
  const s = readFileSync(f, 'utf8');
  assert.match(s, /cron|schedule|\d+\s+\d+\s+\*/i);
  assert.match(s, /drive-headless\.mjs/);                 // 드라이버 경유
  assert.match(s, /fail-closed|budget|proposal-only/i);
});

test('github-actions template is a scheduled workflow calling the driver', () => {
  const f = join(A, 'github-actions-loop.yml'); assert.ok(existsSync(f));
  const s = readFileSync(f, 'utf8');
  assert.match(s, /on:\s*[\s\S]*schedule/);
  assert.match(s, /cron:/);
  assert.match(s, /drive-headless\.mjs/);
  assert.match(s, /proposal-only|사람 승인|human/i);
});
