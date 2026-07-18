import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, verifyLog, recomputeSpent, readLines } from '../scripts/lib/integrity.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { recordCost } from '../scripts/lib/budget.mjs';
import { projectRootDigest } from '../scripts/lib/project-root.mjs';
import { atomicWrite } from '../scripts/lib/envelope.mjs';

const recoveryApiPromise = import('../scripts/lib/project-root-recovery.mjs').catch(() => ({}));

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(runDir(root, 'R'), { recursive: true });
  return root;
}

test('append + verify chain ok', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendEvent(root, 'R', { type: 'cost', data: { turns: 3, tokens: 50 } });
  assert.equal(verifyLog(root, 'R').ok, true);
});

test('recomputeSpent sums cost events', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendEvent(root, 'R', { type: 'decision', data: {} });
  appendEvent(root, 'R', { type: 'cost', data: { turns: 3, tokens: 50 } });
  assert.deepEqual(recomputeSpent(root, 'R'), { turns: 5, tokens: 150 });
});

test('tampered event breaks chain', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendFileSync(join(runDir(root, 'R'), 'event-log.jsonl'),
    JSON.stringify({ seq: 2, ts: 'x', type: 'cost', data: { turns: 999 }, checksum: 'forged' }) + '\n');
  assert.equal(verifyLog(root, 'R').ok, false);
});

// Codex impl r12 🔴: appendAnchored must NOT launder a suffix-truncated log — it fails closed before appending,
// so the stale anchor is preserved (reconcile can still detect the loss) rather than overwritten.
test('appendAnchored fails closed on a truncated event log (no launder)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  recordCost(root, runId, { turns: 1, tokens: 10, requestId: 'integrity-cost-1',
    fence: { owner: runId, generation: 1, intent: 'accounting' } });
  recordCost(root, runId, { turns: 1, tokens: 10, requestId: 'integrity-cost-2',
    fence: { owner: runId, generation: 1, intent: 'accounting' } });
  const anchorBefore = readState(root, runId).data.event_log_head;
  const logPath = join(runDir(root, runId), 'event-log.jsonl');
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  writeFileSync(logPath, lines.slice(0, -1).join('\n') + '\n');   // suffix-truncate the last event
  assert.throws(() => recordCost(root, runId, { turns: 1, tokens: 10,
    requestId: 'integrity-cost-3',
    fence: { owner: runId, generation: 1, intent: 'accounting' } }),
  /RUN_SNAPSHOT_INVALID/);
  // anchor must NOT have advanced (no laundering of the truncation)
  assert.deepEqual(readState(root, runId).data.event_log_head, anchorBefore);
});

test('appendAnchored rechecks project-root binding in-lock before precheck, event, or hash writes', () => {
  const originalRoot = mkdtempSync(join(tmpdir(), 'dl-root-gateway-original-'));
  const candidateRoot = mkdtempSync(join(tmpdir(), 'dl-root-gateway-copy-'));
  const { runId } = initRun(originalRoot, { runtime: 'claude', goal: 'g', now: new Date('2026-07-11T00:00:00Z') });
  appendAnchored(originalRoot, runId, { type: 'seed-event', data: {} }, () => {});
  cpSync(join(originalRoot, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });

  const eventPath = join(runDir(candidateRoot, runId), 'event-log.jsonl');
  const hashPath = join(runDir(candidateRoot, runId), '.loop.hash');
  const beforeEvent = readFileSync(eventPath, 'utf8');
  const beforeHash = readFileSync(hashPath, 'utf8');
  let preCheckRan = false;

  assert.throws(
    () => appendAnchored(candidateRoot, runId, { type: 'must-not-append', data: {} }, () => {}, () => { preCheckRan = true; }),
    /PROJECT_ROOT_FENCED/
  );
  assert.equal(preCheckRan, false, 'root binding must reject before caller preCheck runs');
  assert.equal(readFileSync(eventPath, 'utf8'), beforeEvent, 'root-fenced mutation must emit no event');
  assert.equal(readFileSync(hashPath, 'utf8'), beforeHash, 'root-fenced mutation must not change the loop hash');
});

test('root rebind fails closed on log corruption before event, hash, or state mutation', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'dl-root-integrity-rebind-'));
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'candidate');
  mkdirSync(originalRoot);
  const { runId } = initRun(originalRoot, { runtime: 'claude', goal: 'g', now: new Date('2026-07-11T00:00:00Z') });
  appendAnchored(originalRoot, runId, { type: 'seed-event', data: {} }, () => {});
  const storedRoot = readState(originalRoot, runId).data.project.root;
  renameSync(originalRoot, candidateRoot);

  const dir = runDir(candidateRoot, runId);
  const eventPath = join(dir, 'event-log.jsonl');
  const loopPath = join(dir, 'loop.json');
  const hashPath = join(dir, '.loop.hash');
  const lines = readFileSync(eventPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  lines[0].data = { corrupted: true }; // keep the old checksum: verifyLog must reject it
  writeFileSync(eventPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const before = {
    event: readFileSync(eventPath, 'utf8'),
    loop: readFileSync(loopPath, 'utf8'),
    hash: readFileSync(hashPath, 'utf8'),
  };
  const api = await recoveryApiPromise;
  assert.equal(typeof api.rebindProjectRoot, 'function', 'rebindProjectRoot must be exported');

  assert.throws(
    () => api.rebindProjectRoot(candidateRoot, runId, {
      actor: 'human', confirm: true,
      expectedStoredRootDigest: projectRootDigest(storedRoot),
      fence: { owner: runId, generation: 1 },
      now: Date.parse('2026-07-11T01:00:00Z'),
    }),
    /RUN_SNAPSHOT_INVALID/
  );
  assert.deepEqual({
    event: readFileSync(eventPath, 'utf8'),
    loop: readFileSync(loopPath, 'utf8'),
    hash: readFileSync(hashPath, 'utf8'),
  }, before);
});

// ── v1.6 appendAnchored gateway terminal gate (spec §2.1.5/§4-1b) ────────────
import { appendAnchored } from '../scripts/lib/integrity.mjs';
import { writeState, patch } from '../scripts/lib/state.mjs';

function seededRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-gw-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  return { root, runId };
}
function makeTerminal(root, runId, status = 'completed') {
  return terminal7b(root, runId, { status });
}

test('appendAnchored: terminal gateway blocks any event after caller preCheck (spec §2.1.5)', () => {
  const { root, runId } = seededRun();
  appendAnchored(root, runId, { type: 'x-pre', data: {} }, () => {});   // 로그 생성 (fresh run은 이벤트 0)
  makeTerminal(root, runId, 'completed');
  const logPath = join(runDir(root, runId), 'event-log.jsonl');
  const before = readFileSync(logPath, 'utf8');
  // ① preCheck 없는 직접 append → RUN_TERMINAL: append
  assert.throws(() => appendAnchored(root, runId, { type: 'x-test', data: {} }, () => {}), /RUN_TERMINAL: append/);
  // ③ 순서 계약(4차 r1): caller preCheck의 특정 에러가 관문보다 우선 (fence-first)
  assert.throws(() => appendAnchored(root, runId, { type: 'x-test', data: {} }, () => {},
    () => { throw new Error('LEASE_FENCED: owner-mismatch'); }), /LEASE_FENCED: owner-mismatch/);
  // 로그/상태 무변
  assert.equal(readFileSync(logPath, 'utf8'), before);
  assert.equal(readState(root, runId).data.status, 'completed');
});

test('appendAnchored: fence-less state patch is blocked on terminal (spec §4-1b ②)', () => {
  const { root, runId } = seededRun();
  makeTerminal(root, runId, 'stopped');
  // 'discovered_items'는 classifyPatch 화이트리스트 필드 (비허용 필드는 FIELD_FORBIDDEN이 선착 — 관문 검증 불가)
  assert.throws(() => patch(root, runId, 'discovered_items', [],
    { fence: { owner: runId, generation: 1, intent: 'business' } }), /RUN_TERMINAL/);
});

test('appendAnchored: non-terminal finish transition + auto-floor cost still commit (spec §4-1b ④)', () => {
  const { root, runId } = seededRun();
  terminal7b(root, runId, { status: 'stopped', floor: 1 });
  const { data } = readState(root, runId);
  assert.equal(data.status, 'stopped');   // 전이 자체는 mutate 단계 — preCheck 시점 non-terminal이라 통과
  assert.ok(readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8').includes('auto_floor'));
});

function transientRenameOptions(renameFn) {
  let now = 0;
  return {
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn: (ms) => { now += ms; },
    renameFn,
  };
}

test('a transient state rename retry leaves one anchored event rather than replaying it', () => {
  const { root, runId } = seededRun();
  appendAnchored(root, runId, { type: 'one-business-event', data: {} }, () => {});
  const before = readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8');
  const data = readState(root, runId).data;
  let attempts = 0;
  writeState(root, runId, data, {
    atomicWriteFn: (path, contents) => atomicWrite(path, contents, transientRenameOptions((src, dst) => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('shared'), { code: 'EACCES' });
      renameSync(src, dst);
    })),
  });
  assert.equal(attempts, 3, 'first replacement retries once; second replacement runs once');
  assert.equal(readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8'), before);
  assert.equal(readLines(root, runId).filter(event => event.type === 'one-business-event').length, 1);
});

test('exhausted state rename fails closed without replaying the anchored transaction', () => {
  const { root, runId } = seededRun();
  appendAnchored(root, runId, { type: 'one-fail-stop-event', data: {} }, () => {});
  const eventPath = join(runDir(root, runId), 'event-log.jsonl');
  const before = readFileSync(eventPath, 'utf8');
  const data = readState(root, runId).data;
  const expected = Object.assign(new Error('still shared'), { code: 'EBUSY' });
  assert.throws(() => writeState(root, runId, data, {
    atomicWriteFn: (path, contents) => atomicWrite(path, contents, transientRenameOptions(() => { throw expected; })),
  }), error => error === expected);
  assert.equal(readFileSync(eventPath, 'utf8'), before);
  assert.equal(readLines(root, runId).filter(event => event.type === 'one-fail-stop-event').length, 1);
  assert.doesNotThrow(() => readState(root, runId), 'failed first replacement must leave the prior state/hash pair readable');
});

import { test as test6b } from 'node:test';
import assert6b from 'node:assert/strict';
import { existsSync as exists6b, mkdtempSync as temp6b } from 'node:fs';
import { tmpdir as tmp6b } from 'node:os';
import { join as join6b } from 'node:path';
import { contentHash as digest6b } from '../scripts/lib/envelope.mjs';
import { initRun as init6b } from '../scripts/lib/initrun.mjs';
import { appendAnchored as append6b, readLines as lines6b } from '../scripts/lib/integrity.mjs';
import { runDir as runDir6b } from '../scripts/lib/state.mjs';

const intent6b = (operation, runId, projection = {}) => digest6b(JSON.stringify({
  operation, caller: { owner: runId, generation: 1 }, projection,
}));

test6b('anchored clock is sampled once inside the lock and shared by both events', () => {
  const root = temp6b(join6b(tmp6b(), 'dl-clock-'));
  const { runId } = init6b(root, { runtime: 'codex', goal: 'clock',
    now: new Date('2026-07-13T00:00:00.000Z') });
  const seen = [];
  let samples = 0;
  append6b(root, runId, { type: 'clock-probe', data: {} },
    (_loop, _spent, clock) => seen.push(['mutate', clock]),
    (_loop, clock) => seen.push(['precheck', clock]), {
      floor: 1,
      nowFn: () => {
        samples += 1;
        assert6b.equal(exists6b(join6b(runDir6b(root, runId), '.lock')), true);
        return Date.parse('2026-07-13T00:00:04.000Z');
      },
      callerBinding: { owner: runId, generation: 1 },
      intentDigest: intent6b('clock-probe', runId, { floor: 1 }),
      fenceError: 'LEASE_FENCED: test-clock',
    });
  assert6b.equal(samples, 1);
  assert6b.deepEqual(seen, [
    ['precheck', { ms: 1783900804000, iso: '2026-07-13T00:00:04.000Z' }],
    ['mutate', { ms: 1783900804000, iso: '2026-07-13T00:00:04.000Z' }],
  ]);
  assert6b.deepEqual(lines6b(root, runId).slice(-2).map(event => event.ts),
    ['2026-07-13T00:00:04.000Z', '2026-07-13T00:00:04.000Z']);
});

test6b('invalid injected clock fails before an event append', () => {
  const root = temp6b(join6b(tmp6b(), 'dl-clock-invalid-'));
  const { runId } = init6b(root, { runtime: 'codex', goal: 'clock',
    now: new Date('2026-07-13T00:00:00.000Z') });
  const before = lines6b(root, runId);
  for (const invalid of [Number.NaN, null, '1783900800000']) {
    assert6b.throws(() => append6b(root, runId, { type: 'never', data: {} }, () => {},
      () => {}, { nowFn: () => invalid,
        callerBinding: { owner: runId, generation: 1 },
        intentDigest: intent6b('invalid-clock', runId),
        fenceError: 'LEASE_FENCED: test-clock' }), /INVALID_NOW/);
    assert6b.deepEqual(lines6b(root, runId), before);
  }
  assert6b.throws(() => append6b(root, runId, { type: 'never', data: {} }, () => {},
    () => {}, { nowFn: null,
      callerBinding: { owner: runId, generation: 1 },
      intentDigest: intent6b('invalid-clock', runId),
      fenceError: 'LEASE_FENCED: test-clock' }), /INVALID_NOW/);
  assert6b.deepEqual(lines6b(root, runId), before);
});
import { assertVerifiedRunSnapshot as assertSnapshot7c,
  appendAnchored as append7c, mutationIntentDigest as intent7c,
  readLines as lines7c, readVerifiedState as verified7c,
  withVerifiedMutationLock as mutation7b }
  from '../scripts/lib/integrity.mjs';
import { patch as patch7b, readState as state7c, runDir as runDir7b,
  writeState as writeState7c } from '../scripts/lib/state.mjs';
import { durableRunBytes as bytes7c, rawHashValidState as raw7c,
  legacyInProgressProofFixture as legacyProof7b,
  seedCorrelatedTerminal as terminal7b,
  verifiedAppRun as fixture7c } from './fixtures/verified-app-run.mjs';
import { spawnSync as spawn7c } from 'node:child_process';
import { existsSync as existsJournal7b, mkdirSync as mkdir7b, readdirSync as list7b,
  readFileSync as readSource7b, rmdirSync as rmdir7b } from 'node:fs';
import { join as join7b } from 'node:path';
import { fileURLToPath as file7b } from 'node:url';
import { acquireLease as acquire7b } from '../scripts/lib/lease.mjs';
import { finishRun as finish7b } from '../scripts/lib/finish.mjs';
import { newWorkstream as workstream7b } from '../scripts/lib/workspace.mjs';
import { initializationRequestDigest as initDigest7c }
  from '../scripts/lib/init-transaction.mjs';

const probeIntent7c = (operation, owner, generation, projection = {}) =>
  intent7c(`test-${operation}`, { owner, generation }, projection);

test6b('immutable genesis event rejects a paired projection and digest rewrite', () => {
  const { root, runId } = fixture7c('dl-genesis-paired-rewrite-');
  raw7c(root, runId, loop => {
    loop.initialization.request_projection.goal = 'paired rewrite';
    loop.initialization.request_digest = initDigest7c(
      loop.initialization.request_projection);
  });
  const before = bytes7c(root, runId);
  assert6b.throws(() => verified7c(root, runId),
    /run-initialized genesis binding invalid/);
  assert6b.deepEqual(bytes7c(root, runId), before);
});

test6b('split fence precedes semantic proof but no-op business sentinels cannot bypass it', () => {
  const { root, runId, owner, generation } = fixture7c();
  raw7c(root, runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:01.000Z';
  });
  const before = bytes7c(root, runId);
  assert6b.throws(() => verified7c(root, runId, { fenceCheck: loop => {
    if (loop.session_chain.lease.owner_run_id !== 'wrong') throw new Error('LEASE_FENCED');
  } }), /LEASE_FENCED/, 'wrong caller retains fence-first result');
  assert6b.throws(() => append7c(root, runId, { type: 'never', data: {} }, () => {},
    () => { throw new Error('ALREADY_SENTINEL'); }, {
      fenceCheck: loop => {
        if (loop.session_chain.lease.owner_run_id !== 'wrong') throw new Error('LEASE_FENCED');
      },
      callerBinding: { owner, generation },
      intentDigest: probeIntent7c('split-fence-sentinel', owner, generation),
      fenceError: 'LEASE_FENCED',
    }), /LEASE_FENCED/, 'wrong caller retains fence-first result');
  let clockCalls = 0;
  assert6b.throws(() => append7c(root, runId, { type: 'never', data: {} }, () => {},
    () => { throw new Error('ALREADY_SENTINEL'); }, {
      nowFn: () => { clockCalls += 1; return Number.NaN; },
      fenceCheck: loop => {
        if (loop.session_chain.lease.owner_run_id !== 'wrong') throw new Error('LEASE_FENCED');
      },
      callerBinding: { owner, generation },
      intentDigest: probeIntent7c('split-fence-clock', owner, generation),
      fenceError: 'LEASE_FENCED',
    }), /LEASE_FENCED/, 'identity fence precedes clock sampling and validation');
  assert6b.equal(clockCalls, 0, 'a fenced caller cannot execute the clock callback');
  assert6b.throws(() => append7c(root, runId, { type: 'never', data: {} }, () => {},
    () => { throw new Error('ALREADY_SENTINEL'); }, { fenceCheck: () => {},
      callerBinding: { owner, generation },
      intentDigest: probeIntent7c('split-fence-proof', owner, generation),
      fenceError: 'LEASE_FENCED' }),
  /RUN_SNAPSHOT_INVALID/, 'semantic proof precedes the success-class business sentinel');
  assert6b.throws(() => verified7c(root, runId), /RUN_SNAPSHOT_INVALID/);
  assert6b.throws(() => assertSnapshot7c(root, runId, state7c(root, runId).data),
    /RUN_SNAPSHOT_INVALID/);
  assert6b.deepEqual(bytes7c(root, runId), before);
});

test6b('prospective App correlation failure writes no event, state, or hash byte', () => {
  const { root, runId, owner, generation } = fixture7c('dl-prospective-proof-');
  const before = bytes7c(root, runId);
  assert6b.throws(() => append7c(root, runId, {
    type: 'app-task-consent-revoked', data: { owner_run_id: owner, generation,
      attempt_id: null, child_run_id: null, failure_code: null },
  }, () => {}, () => {}, {
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z'),
    fenceCheck: loop => {
      if (loop.session_chain.lease.owner_run_id !== owner
          || loop.session_chain.lease.generation !== generation) throw new Error('LEASE_FENCED');
    },
    callerBinding: { owner, generation },
    intentDigest: probeIntent7c('prospective-app-correlation', owner, generation),
    fenceError: 'LEASE_FENCED',
  }), /RUN_SNAPSHOT_INVALID/,
  'a revoke event without its candidate consent mutation fails before the first append');
  assert6b.deepEqual(bytes7c(root, runId), before);

  for (const [label, mutate, expected] of [
    ['run identity', candidate => { candidate.run_id = 'OTHER-RUN-ID'; },
      /RUN_SNAPSHOT_INVALID: run_id mismatch/],
    ['project root', candidate => {
      candidate.project.root = join(root, 'nonexistent-project-root');
    }, /PROJECT_ROOT_/],
  ]) {
    const fixture = fixture7c(`dl-prospective-${label.replace(' ', '-')}-`);
    const original = bytes7c(fixture.root, fixture.runId);
    assert6b.throws(() => append7c(fixture.root, fixture.runId,
      { type: 'verified-boundary-probe', data: { label } }, mutate, () => {}, {
        nowFn: () => Date.parse('2026-07-13T00:00:01.000Z'),
        fenceCheck: loop => {
          if (loop.session_chain.lease.owner_run_id !== fixture.owner
              || loop.session_chain.lease.generation !== fixture.generation) {
            throw new Error('LEASE_FENCED');
          }
        },
        callerBinding: { owner: fixture.owner, generation: fixture.generation },
        intentDigest: probeIntent7c('prospective-boundary', fixture.owner,
          fixture.generation, { label }),
        fenceError: 'LEASE_FENCED',
      }), expected, `${label} candidate must fail before its event byte`);
    assert6b.deepEqual(bytes7c(fixture.root, fixture.runId), original);
  }
});

test6b('verified mutation gateway exposes null before a commit and exact proof after recovery', () => {
  const clean = fixture7c('dl-mutation-gateway-clean-');
  const cleanBinding = { owner: clean.owner, generation: clean.generation };
  const cleanIntent = intent7c('gateway-clean', cleanBinding, { request: 'clean' });
  let cleanRecovered = 'unset';
  const cleanResult = mutation7b(clean.root, clean.runId, {
    callerBinding: cleanBinding, intentDigest: cleanIntent,
    fenceError: 'LEASE_FENCED: gateway-clean',
  }, mutation => {
    cleanRecovered = mutation.recovered;
    return mutation.readVerifiedState().data.run_id;
  });
  assert6b.equal(cleanRecovered, null);
  assert6b.equal(cleanResult, clean.runId);

  const pending = fixture7c('dl-mutation-gateway-pending-');
  const binding = { owner: pending.owner, generation: pending.generation };
  const intentDigest = intent7c('anchored-crash-probe', binding, {});
  const worker = file7b(new URL('./helpers/anchored-crash-worker.mjs', import.meta.url));
  const child = spawn7c(process.execPath,
    [worker, pending.root, pending.runId, 'generic-append', 'pending-after-rename'], {
      shell: false, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, DEEP_LOOP_CRASH_OWNER: pending.owner,
        DEEP_LOOP_CRASH_GENERATION: String(pending.generation) },
    });
  assert6b.equal(child.status, 91, child.stderr || child.stdout || child.error?.message);
  rmdir7b(join7b(pending.root, '.deep-loop', 'runs', pending.runId, '.lock'));

  const recovered = mutation7b(pending.root, pending.runId, {
    callerBinding: binding, intentDigest,
    fenceError: 'LEASE_FENCED: gateway-pending',
  }, mutation => {
    mutation.readVerifiedState();
    return mutation.recovered;
  });
  assert6b.notEqual(recovered, null);
  assert6b.equal(recovered.events.length, 1);
  assert6b.equal(recovered.events[0].type, 'anchored-crash-probe');
  assert6b.deepEqual(recovered.events[0].data,
    { owner: pending.owner, generation: pending.generation });
  const durable = lines7c(pending.root, pending.runId)
    .filter(event => event.type === 'anchored-crash-probe');
  assert6b.equal(durable.length, 1);
  assert6b.equal(recovered.events[0].seq, durable[0].seq,
    'recovery exposes the exact durable event sequence');
  assert6b.equal(recovered.events[0].checksum, durable[0].checksum,
    'recovery exposes the exact durable event checksum');
});

test6b('prospective commit persists the exact proved event timestamp', () => {
  const { root, runId, owner, generation } = fixture7c('dl-exact-proved-candidate-');
  const now = Date.parse('2026-07-13T00:00:01.000Z');
  append7c(root, runId, { type: 'verified-stamp', data: {} }, () => {}, () => {}, {
    nowFn: () => now,
    fenceCheck: loop => {
      if (loop.session_chain.lease.owner_run_id !== owner
          || loop.session_chain.lease.generation !== generation) throw new Error('LEASE_FENCED');
    },
    callerBinding: { owner, generation },
    intentDigest: probeIntent7c('prospective-stamp', owner, generation),
    fenceError: 'LEASE_FENCED',
  });
  const event = lines7c(root, runId).at(-1);
  assert6b.equal(event.ts, new Date(now).toISOString());
  assert6b.equal(state7c(root, runId).data.updated_at, event.ts);
});

test6b('writeState and cold fresh-process imports enforce the same verified boundary', () => {
  const { root, runId } = fixture7c('dl-write-proof-');
  const candidate = state7c(root, runId).data;
  candidate.session_chain.sessions[0].host_surface.observed_at =
    '2026-07-13T00:00:01.000Z';
  const before = bytes7c(root, runId);
  assert6b.throws(() => writeState7c(root, runId, candidate), /RUN_SNAPSHOT_INVALID/);
  assert6b.deepEqual(bytes7c(root, runId), before);
  const identity = fixture7c('dl-write-run-identity-');
  const identityCandidate = state7c(identity.root, identity.runId).data;
  identityCandidate.run_id = 'DIFFERENT-RUN-ID';
  const identityBefore = bytes7c(identity.root, identity.runId);
  assert6b.throws(() => writeState7c(identity.root, identity.runId, identityCandidate),
    /RUN_SNAPSHOT_INVALID: run_id mismatch/);
  assert6b.deepEqual(bytes7c(identity.root, identity.runId), identityBefore);
  const modules = [new URL('../scripts/lib/state.mjs', import.meta.url).href,
    new URL('../scripts/lib/integrity.mjs', import.meta.url).href];
  for (const order of [modules, [...modules].reverse()]) {
    const source = order.map(url => `await import(${JSON.stringify(url)})`).join(';');
    const child = spawn7c(process.execPath, ['--input-type=module', '--eval', source],
      { encoding: 'utf8' });
    assert6b.equal(child.status, 0, child.stderr || child.stdout);
  }
});

const PUBLIC_MUTATION_INVENTORY7B = Object.freeze({
  'workspace.mjs': ['newWorkstream'],
  'state.mjs': ['patch'],
  'finish.mjs': ['finishRun'],
  'lease.mjs': ['acquireLease'],
});

test6b('Task 7B staged mutation inventory enters recovery before any canonical read', () => {
  const canonicalRead = /\b(?:readState|readVerifiedState|reconcileBudget)\s*\(/;
  const recoveryEntry = /\b(?:withVerifiedMutationLock|appendAnchored|newEpisode|newBlockedCheckerEpisode|commitReviewOutcome|appendTransition|respawnOperation)\s*\(/;
  for (const [file, exports] of Object.entries(PUBLIC_MUTATION_INVENTORY7B)) {
    const source = readSource7b(new URL(`../scripts/lib/${file}`, import.meta.url), 'utf8');
    for (const name of exports) {
      const start = source.indexOf(`export function ${name}`);
      assert6b.notEqual(start, -1, `${file}:${name} missing from closed inventory`);
      const next = source.indexOf('\nexport function ', start + 1);
      const body = source.slice(start, next < 0 ? source.length : next);
      const entry = body.search(recoveryEntry);
      const read = body.search(canonicalRead);
      assert6b.notEqual(entry, -1, `${file}:${name} has no recovery-aware entry`);
      assert6b.ok(read < 0 || entry < read,
        `${file}:${name} performs a canonical read before journal recovery`);
    }
  }
});
const GENERIC_CRASH_POINTS7B = Object.freeze([
  'state-stage-after-rename', 'event-stage-after-rename', 'pending-after-rename',
  'event-after-partial-append', 'event-after-full-append', 'state-after-rename',
  'hash-after-rename', 'before-cleanup',
  'state-replace-after-create', 'state-replace-after-fsync',
  'state-replace-after-rename-before-dir-fsync',
  'hash-replace-after-create', 'hash-replace-after-fsync',
  'hash-replace-after-rename-before-dir-fsync',
]);
const GENERIC_PRE_MARKER7B = new Set([
  'state-stage-after-rename', 'event-stage-after-rename',
]);
const GENERIC_EVENT7B = Object.freeze({
  'generic-append': 'anchored-crash-probe', 'generic-acquire': 'lease-acquired',
  finish: 'finish', 'state-patch': 'state-patch', 'workstream-new': 'workstream-new',
});

function fixedJournalInventory7b(root, runId) {
  return list7b(runDir7b(root, runId)).sort().filter(name =>
    (name.startsWith('.anchored-') && name !== '.anchored-committed.json')
      || name === 'loop.json.replace'
      || name === '.loop.hash.replace');
}

function expectedJournalInventory7b(point) {
  if (point === 'state-stage-after-rename') return ['.anchored-state.stage'];
  if (point === 'event-stage-after-rename') {
    return ['.anchored-events.stage', '.anchored-state.stage'];
  }
  const names = ['.anchored-events.stage', '.anchored-hash.stage',
    '.anchored-pending.json', '.anchored-state.stage'];
  if (point === 'state-replace-after-create' || point === 'state-replace-after-fsync') {
    names.push('loop.json.replace');
  }
  if (point === 'hash-replace-after-create' || point === 'hash-replace-after-fsync') {
    names.push('.loop.hash.replace');
  }
  return names.sort();
}

function completeJournalBytes7b(root, runId) {
  const directory = runDir7b(root, runId);
  const names = [...fixedJournalInventory7b(root, runId),
    'event-log.jsonl', 'loop.json', '.loop.hash'];
  return Object.fromEntries(names.map(name =>
    [name, existsJournal7b(join7b(directory, name))
      ? readSource7b(join7b(directory, name)) : null]));
}

function genericCrashCase7b(operation) {
  const fixture = fixture7c(`dl-generic-${operation}-`);
  mkdir7b(join7b(fixture.root, '.worktrees'), { recursive: true });
  if (operation === 'generic-acquire') {
    raw7c(fixture.root, fixture.runId, loop => {
      loop.session_chain.lease.state = 'released';
    });
  }
  const fence = { owner: fixture.owner, generation: fixture.generation };
  const patchValue = ['crash-probe'];
  const workstream = { title: 'crash probe', branch: 'codex/crash-probe',
    worktree: '.worktrees/crash-probe', baseCommit: null, dependsOn: [],
    requestId: 'workstream-crash-probe-1' };
  const invoke = ({ foreign = false, different = false } = {}) => {
    const owner = foreign ? '01JAPPF0R00000000000000000' : fixture.owner;
    const caller = { owner, generation: fixture.generation };
    if (operation === 'generic-append') {
      const data = { owner, generation: fixture.generation, ...(different ? { variant: 2 } : {}) };
      return append7c(fixture.root, fixture.runId,
        { type: 'anchored-crash-probe', data }, () => {}, undefined, {
          callerBinding: caller,
          intentDigest: intent7c('anchored-crash-probe', caller,
            different ? { variant: 2 } : {}),
          fenceError: 'LEASE_FENCED: generic-append',
        });
    }
    if (operation === 'generic-acquire') {
      return acquire7b(fixture.root, fixture.runId, { owner,
        expectGeneration: fixture.generation, runtime: different ? 'claude' : 'codex' });
    }
    if (operation === 'finish') {
      return finish7b(fixture.root, fixture.runId, { status: 'stopped', confirm: true,
        reportRel: null, proof: { human_reason: different ? 'different' : 'crash-worker' },
        fence: { ...caller, runtime: 'codex', intent: 'business' } });
    }
    if (operation === 'state-patch') {
      return patch7b(fixture.root, fixture.runId, 'decisions',
        different ? ['different'] : patchValue, { fence: caller });
    }
    return workstream7b(fixture.root, fixture.runId,
      { ...workstream, ...(different ? { branch: 'codex/crash-probe-other',
        worktree: '.worktrees/crash-probe-other' } : {}), fence: caller });
  };
  const retryWithResult = operation === 'generic-append' ? () => {
    const caller = { owner: fixture.owner, generation: fixture.generation };
    return append7c(fixture.root, fixture.runId,
      { type: 'anchored-crash-probe', data: { owner: fixture.owner,
        generation: fixture.generation } }, () => {}, undefined, {
        callerBinding: caller,
        intentDigest: intent7c('anchored-crash-probe', caller, {}),
        fenceError: 'LEASE_FENCED: generic-append',
        onRecovered: (_loop, recovered) => recovered.events[0],
      });
  } : null;
  const workerInput = operation === 'generic-acquire'
    ? { childOwner: fixture.owner }
    : operation === 'state-patch' ? { field: 'decisions', value: patchValue }
      : operation === 'workstream-new' ? workstream : {};
  return { fixture, invoke, retryWithResult, workerInput };
}

function assertGenericCrashRecovery7b(operation, point) {
  const { fixture, invoke, workerInput } = genericCrashCase7b(operation);
  const canonicalBefore = bytes7c(fixture.root, fixture.runId);
  const worker = file7b(new URL('./helpers/anchored-crash-worker.mjs', import.meta.url));
  const child = spawn7c(process.execPath,
    [worker, fixture.root, fixture.runId, operation, point], {
      shell: false, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, DEEP_LOOP_CRASH_OWNER: fixture.owner,
        DEEP_LOOP_CRASH_GENERATION: String(fixture.generation),
        DEEP_LOOP_CRASH_INPUT: JSON.stringify(workerInput) },
    });
  assert6b.notEqual(child.error?.code, 'ETIMEDOUT', `${operation}/${point} worker timeout`);
  assert6b.equal(child.status, 91, child.stderr || child.stdout || child.error?.message);
  // A hard process exit cannot run withLock's finally block. Once spawnSync proves that exact
  // owner is dead, accelerate the production stale-lock TTL by removing only its orphan lock.
  // Journal/state recovery remains exclusively owned by the exact public API retry below.
  rmdir7b(join7b(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
  assert6b.deepEqual(fixedJournalInventory7b(fixture.root, fixture.runId),
    expectedJournalInventory7b(point), `${operation}/${point} exact journal inventory`);
  const pending = completeJournalBytes7b(fixture.root, fixture.runId);

  if (GENERIC_PRE_MARKER7B.has(point)) {
    assert6b.deepEqual(bytes7c(fixture.root, fixture.runId), canonicalBefore,
      `${operation}/${point} changed canonical bytes before marker publication`);
    assert6b.doesNotThrow(() => verified7c(fixture.root, fixture.runId));
  } else {
    assert6b.throws(() => verified7c(fixture.root, fixture.runId),
      /ANCHORED_TRANSACTION_PENDING/);
    for (const variant of [{ foreign: true }, { different: true }]) {
      let result;
      try { result = invoke(variant); }
      catch (error) { assert6b.match(String(error?.message || error), /FENCED|PENDING/); }
      if (result !== undefined) assert6b.equal(result.ok, false);
      assert6b.deepEqual(completeJournalBytes7b(fixture.root, fixture.runId), pending,
        `${operation}/${point} divergent retry changed bytes`);
    }
  }
  assert6b.deepEqual(completeJournalBytes7b(fixture.root, fixture.runId), pending,
    `${operation}/${point} read-only status changed journal bytes`);
  invoke();
  assert6b.deepEqual(fixedJournalInventory7b(fixture.root, fixture.runId), []);
  assert6b.equal(list7b(runDir7b(fixture.root, fixture.runId))
    .filter(name => name === '.anchored-committed.json').length, 1,
  `${operation}/${point} keeps exactly one bounded committed receipt`);
  assert6b.equal(lines7c(fixture.root, fixture.runId)
    .filter(event => event.type === GENERIC_EVENT7B[operation]).length, 1,
  `${operation}/${point} must converge to one business event`);
}

test6b('anchored crash parent matrix preserves orphans pending bytes and exact retry convergence', () => {
  for (const operation of ['generic-append', 'generic-acquire', 'finish',
    'state-patch', 'workstream-new']) {
    for (const point of GENERIC_CRASH_POINTS7B) assertGenericCrashRecovery7b(operation, point);
  }
});

const CLEANUP_CRASH_POINTS7B = Object.freeze([
  'cleanup-events-after-unlink', 'cleanup-state-after-unlink',
  'cleanup-hash-after-unlink', 'cleanup-marker-after-unlink',
  'response-after-cleanup',
]);

test6b('generic append cleanup interruption and final response loss remain exactly idempotent', () => {
  const worker = file7b(new URL('./helpers/anchored-crash-worker.mjs', import.meta.url));
  for (const point of CLEANUP_CRASH_POINTS7B) {
    const { fixture, invoke, retryWithResult, workerInput } =
      genericCrashCase7b('generic-append');
    const child = spawn7c(process.execPath,
      [worker, fixture.root, fixture.runId, 'generic-append', point], {
        shell: false, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, DEEP_LOOP_CRASH_OWNER: fixture.owner,
          DEEP_LOOP_CRASH_GENERATION: String(fixture.generation),
          DEEP_LOOP_CRASH_INPUT: JSON.stringify(workerInput) },
      });
    assert6b.equal(child.status, 91,
      `${point}: ${child.stderr || child.stdout || child.error?.message}`);
    rmdir7b(join7b(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
    if (!['cleanup-marker-after-unlink', 'response-after-cleanup'].includes(point)) {
      const pending = completeJournalBytes7b(fixture.root, fixture.runId);
      for (const variant of [{ foreign: true }, { different: true }]) {
        assert6b.throws(() => invoke(variant), /FENCED|PENDING/);
        assert6b.deepEqual(completeJournalBytes7b(fixture.root, fixture.runId), pending,
          `${point} divergent retry changed cleanup bytes`);
      }
    }
    const recovered = retryWithResult();
    assert6b.equal(recovered?.type, GENERIC_EVENT7B['generic-append']);
    assert6b.deepEqual(recovered?.data,
      { owner: fixture.owner, generation: fixture.generation });
    assert6b.equal(lines7c(fixture.root, fixture.runId)
      .filter(event => event.type === GENERIC_EVENT7B['generic-append']).length, 1,
    `${point} exact retry must not duplicate its committed event`);
    assert6b.doesNotThrow(() => verified7c(fixture.root, fixture.runId));
  }
});

test6b('matching committed receipt with a divergent canonical snapshot fails closed', () => {
  const { fixture, invoke } = genericCrashCase7b('generic-append');
  invoke();
  const receiptPath = join7b(runDir7b(fixture.root, fixture.runId),
    '.anchored-committed.json');
  const receipt = JSON.parse(readSource7b(receiptPath, 'utf8'));
  receipt.after.events_digest = '0'.repeat(64);
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const before = bytes7c(fixture.root, fixture.runId);
  const receiptBefore = readSource7b(receiptPath);
  assert6b.throws(() => invoke(), /ANCHORED_TRANSACTION_CORRUPT/);
  assert6b.deepEqual(bytes7c(fixture.root, fixture.runId), before);
  assert6b.deepEqual(readSource7b(receiptPath), receiptBefore);
  assert6b.equal(lines7c(fixture.root, fixture.runId)
    .filter(event => event.type === GENERIC_EVENT7B['generic-append']).length, 1);
});

test6b('committed receipt rejects a forged before event boundary without writes', () => {
  const { fixture, retryWithResult, invoke } = genericCrashCase7b('generic-append');
  invoke();
  const receiptPath = join7b(runDir7b(fixture.root, fixture.runId),
    '.anchored-committed.json');
  const receipt = JSON.parse(readSource7b(receiptPath, 'utf8'));
  receipt.before.events_bytes = receipt.after.events_bytes;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const before = bytes7c(fixture.root, fixture.runId);
  const receiptBefore = readSource7b(receiptPath);
  assert6b.throws(() => retryWithResult(), /ANCHORED_TRANSACTION_CORRUPT/);
  assert6b.deepEqual(bytes7c(fixture.root, fixture.runId), before);
  assert6b.deepEqual(readSource7b(receiptPath), receiptBefore);
  assert6b.equal(lines7c(fixture.root, fixture.runId)
    .filter(event => event.type === GENERIC_EVENT7B['generic-append']).length, 1);
});

test6b('committed receipt rejects a forged before event digest without writes', () => {
  const { fixture, retryWithResult, invoke } = genericCrashCase7b('generic-append');
  invoke();
  const receiptPath = join7b(runDir7b(fixture.root, fixture.runId),
    '.anchored-committed.json');
  const receipt = JSON.parse(readSource7b(receiptPath, 'utf8'));
  receipt.before.events_digest = '0'.repeat(64);
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const before = bytes7c(fixture.root, fixture.runId);
  const receiptBefore = readSource7b(receiptPath);
  assert6b.throws(() => retryWithResult(), /ANCHORED_TRANSACTION_CORRUPT/);
  assert6b.deepEqual(bytes7c(fixture.root, fixture.runId), before);
  assert6b.deepEqual(readSource7b(receiptPath), receiptBefore);
  assert6b.equal(lines7c(fixture.root, fixture.runId)
    .filter(event => event.type === GENERIC_EVENT7B['generic-append']).length, 1);
});

test6b('eligible legacy proof fixture checkpoints once and keeps later proof continuity', () => {
  const fixture = legacyProof7b();
  patch7b(fixture.root, fixture.runId, 'decisions', ['first'], { fence: fixture.fence });
  let lines = lines7c(fixture.root, fixture.runId);
  const checkpoints = lines.filter(event => event.type === 'lease-lineage-baselined');
  assert6b.equal(checkpoints.length, 1);
  assert6b.deepEqual(checkpoints[0].data.legacy_active_workstreams,
    [fixture.workstreamId]);
  assert6b.deepEqual(checkpoints[0].data.legacy_proof_origins
    .map(origin => `${origin.kind}:${origin.id}`),
  [`episode:${fixture.makerId}`, `workstream:${fixture.workstreamId}`]);
  assert6b.deepEqual(state7c(fixture.root, fixture.runId).data.active_workstreams,
    [fixture.workstreamId]);

  patch7b(fixture.root, fixture.runId, 'decisions', ['second'], { fence: fixture.fence });
  lines = lines7c(fixture.root, fixture.runId);
  assert6b.equal(lines.filter(event => event.type === 'lease-lineage-baselined').length, 1);
  assert6b.equal(lines.filter(event => event.type === 'state-patch').length, 2);
  assert6b.doesNotThrow(() => verified7c(fixture.root, fixture.runId));
});

test6b('unbaselined legacy App authority remains ineligible for a verified mutation', () => {
  const fixture = legacyProof7b({ appAuthority: true });
  const before = bytes7c(fixture.root, fixture.runId);
  assert6b.throws(() => patch7b(fixture.root, fixture.runId,
    'decisions', ['forbidden'], { fence: fixture.fence }),
  /RUN_SNAPSHOT_INVALID|LEGACY_LINEAGE_CHECKPOINT_INELIGIBLE/);
  assert6b.deepEqual(bytes7c(fixture.root, fixture.runId), before);
});
