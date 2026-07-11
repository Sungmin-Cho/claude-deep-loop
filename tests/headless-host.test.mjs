import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driveHeadless, driveHeadlessRun } from '../scripts/lib/headless-host.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease, advanceHandoffPhase } from '../scripts/lib/lease.mjs';
import { recordCost } from '../scripts/lib/budget.mjs';
import { readLines } from '../scripts/lib/integrity.mjs';
import { respawn } from '../scripts/lib/respawn.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';

const NOW0 = new Date('2026-07-11T00:00:00Z');
const NOW1 = Date.parse('2026-07-11T00:01:00Z');

function measuredUsage(inputTokens) {
  return {
    num_turns: 1,
    input_tokens: inputTokens,
    output_tokens: 1,
    tokens: inputTokens + 1,
  };
}

function seedCodexHandoff() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-headless-host-')));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'g', now: NOW0, env: {}, platform: 'linux',
    run: () => ({ code: 1 }),
  });
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'headless';
  data.autonomy.runtime_executable_approval = {
    runtime: 'codex',
    canonical_path: '/opt/codex/bin/codex',
    sha256: 'a'.repeat(64),
    version: '0.144.1',
    platform: process.platform,
    arch: process.arch,
    source: 'human-explicit',
    package: null,
    authenticode: null,
    approved_by: 'human',
    approved_at: '2026-07-11T00:00:00.000Z',
  };
  writeState(root, runId, data);
  const handoff = emitHandoff(root, runId, {
    trigger: 'milestone',
    headless: true,
    resumePolicy: 'headless',
    expect: { owner: runId, generation: 1 },
    now: NOW1,
  });
  assert.equal(handoff.ok, true);
  return { root, runId, childRunId: handoff.childRunId };
}

function seedClaudeHandoff() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-headless-host-claude-')));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: NOW0, env: {}, platform: 'linux',
    run: () => ({ code: 1 }),
  });
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'headless';
  writeState(root, runId, data);
  const handoff = emitHandoff(root, runId, {
    trigger: 'milestone',
    headless: true,
    resumePolicy: 'headless',
    expect: { owner: runId, generation: 1 },
    now: NOW1,
  });
  assert.equal(handoff.ok, true);
  return { root, runId, childRunId: handoff.childRunId };
}

function codexHostDeps(root, runId) {
  const executable = readState(root, runId).data.autonomy.runtime_executable_approval;
  const codexHome = {
    canonical_path: '/home/test/.codex', device: '1', inode: '2',
    birthtime_ns: '3', platform: process.platform,
  };
  return {
    env: { PATH: '/usr/bin', CODEX_HOME: codexHome.canonical_path },
    revalidateExecutable: () => executable,
    resolveCodexHome: () => codexHome,
    executable,
    codexHome,
  };
}

function prepareCompletableCodexRun(root, runId) {
  const state = readState(root, runId).data;
  state.review.points = ['implementation'];
  state.episodes = [
    { id: '001-maker', role: 'maker', plugin: 'deep-work', point: 'implementation', workstream_id: 'ws', status: 'done' },
    { id: '002-checker', role: 'checker', plugin: 'deep-review', point: 'implementation', workstream_id: 'ws', status: 'approved', target_maker: '001-maker' },
  ];
  state.workstreams = [{ id: 'ws', status: 'ready', review_points_done: ['implementation'] }];
  state.active_workstreams = [];
  writeState(root, runId, state);
  writeFileSync(join(runDir(root, runId), 'final-report.md'), '# complete');
}

test('cache miss records two preflight turns before one post-CAS maker turn', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const order = [];
  const { executable, codexHome, ...deps } = codexHostDeps(root, runId);

  const result = driveHeadlessRun({
    root,
    runId,
    now: NOW1 + 1_000,
    timeoutMs: 12_345,
    ...deps,
    preflightFn: () => {
      order.push('preflight');
      return {
        ok: true,
        cache_hit: false,
        measured_usage: [measuredUsage(10), measuredUsage(20)],
      };
    },
    recordCostFn: (projectRoot, id, options) => {
      order.push(`cost:${options.tokens}`);
      return recordCost(projectRoot, id, options);
    },
    spawnFn: (entry, options) => {
      order.push('maker');
      assert.equal(options.timeoutMs, 12_345);
      assert.equal(entry.bin, executable.canonical_path);
      assert.equal(entry.shell, false);
      assert.equal(entry.cwd, root);
      assert.equal(entry.usageOutputKind, 'codex-jsonl');
      assert.equal(entry.env.CODEX_HOME, codexHome.canonical_path);
      assert.equal(entry.env.DEEP_LOOP_OWNER, childRunId);
      assert.equal(entry.env.DEEP_LOOP_GENERATION, '2');
      acquireLease(root, runId, {
        owner: childRunId,
        expectGeneration: 1,
        runtime: 'codex',
        now: NOW1 + 2_000,
      });
      return { ok: true, usage: measuredUsage(30) };
    },
  });

  assert.deepEqual(order, ['preflight', 'cost:11', 'cost:21', 'maker', 'cost:31'], JSON.stringify(result));
  assert.deepEqual(result, {
    ok: true,
    action: 'resumed',
    usage: measuredUsage(30),
    recorded: true,
  });
  const costs = readLines(root, runId).filter((event) => event.type === 'cost');
  assert.deepEqual(costs.map((event) => event.data.reported_tokens), [11, 21, 31]);
});

test('cache hit has no smoke usage to replay and still runs the maker exactly once', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const { executable, ...deps } = codexHostDeps(root, runId);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({
      ok: true,
      cache_hit: true,
      measured_usage: [],
    }),
    spawnFn: (entry) => {
      makerCalls += 1;
      assert.equal(entry.bin, executable.canonical_path);
      acquireLease(root, runId, {
        owner: childRunId,
        expectGeneration: 1,
        runtime: 'codex',
        now: NOW1 + 2_000,
      });
      return { ok: true, usage: measuredUsage(30) };
    },
  });

  assert.equal(result.action, 'resumed');
  assert.equal(makerCalls, 1);
  const costs = readLines(root, runId).filter((event) => event.type === 'cost');
  assert.deepEqual(costs.map((event) => event.data.reported_tokens), [31]);
});

test('receipt-settled preflight is accounted through the injected kernel settler and never replayed generically', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  const receiptIds = ['a'.repeat(64), 'b'.repeat(64)];
  const settled = [];
  let genericRecords = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    now: NOW1 + 1_000,
    ...deps,
    settlePreflightCostFn: (projectRoot, id, { receipt, fence }) => {
      assert.equal(projectRoot, root);
      assert.equal(id, runId);
      assert.deepEqual(fence, { owner: runId, generation: 1, intent: 'accounting' });
      settled.push(receipt.receipt_id);
      return { ok: true, recorded: true, reason: 'recorded' };
    },
    preflightFn: (options) => {
      assert.equal(typeof options.settleAccountingReceipt, 'function');
      for (const receipt_id of receiptIds) options.settleAccountingReceipt({ receipt_id });
      return {
        ok: true,
        cache_hit: false,
        measured_usage: [measuredUsage(10), measuredUsage(20)],
        accounting_settled: true,
        accounting_receipts: receiptIds,
      };
    },
    recordCostFn: (...args) => {
      genericRecords += 1;
      return recordCost(...args);
    },
    spawnFn: () => {
      acquireLease(root, runId, {
        owner: childRunId, expectGeneration: 1, runtime: 'codex', now: NOW1 + 2_000,
      });
      return { ok: true, usage: measuredUsage(30) };
    },
  });

  assert.equal(result.action, 'resumed');
  assert.deepEqual(settled, receiptIds);
  assert.equal(genericRecords, 1, 'only the maker usage uses the generic post-process recorder');
});

test('terminal Codex maker usage is settled once after the acquired child completes the run', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  prepareCompletableCodexRun(root, runId);

  const result = driveHeadlessRun({
    root,
    runId,
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
    spawnFn: () => {
      const acquired = acquireLease(root, runId, {
        owner: childRunId, expectGeneration: 1, runtime: 'codex', now: NOW1 + 2_000,
      });
      assert.equal(acquired.ok, true);
      finishRun(root, runId, {
        status: 'completed', reportRel: 'final-report.md',
        fence: { owner: childRunId, generation: 2, intent: 'business' }, now: NOW1 + 3_000,
      });
      return { ok: true, usage: measuredUsage(30) };
    },
  });

  assert.deepEqual(result, {
    ok: true, action: 'resumed', usage: measuredUsage(30), recorded: true,
  });
  const after = readState(root, runId).data;
  assert.equal(after.status, 'completed');
  assert.equal(after.budget.spent, 1, 'the one measured maker turn must absorb the finish mutation floor');
  assert.equal(after.budget.tokens_spent, 31);
  const terminalCosts = readLines(root, runId).filter(
    event => event.type === 'cost' && event.data.terminal_process === 'codex-maker',
  );
  assert.equal(terminalCosts.length, 1);
  assert.equal(terminalCosts[0].data.reported_turns, 1);
  assert.equal(terminalCosts[0].data.reported_tokens, 31);
});

test('terminal Codex maker settlement failure is explicit and never reported as a successful resume', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  prepareCompletableCodexRun(root, runId);

  const result = driveHeadlessRun({
    root,
    runId,
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
    settleTerminalCostFn: () => { throw new Error('LOG_TAMPERED: injected terminal settlement failure'); },
    spawnFn: () => {
      acquireLease(root, runId, {
        owner: childRunId, expectGeneration: 1, runtime: 'codex', now: NOW1 + 2_000,
      });
      finishRun(root, runId, {
        status: 'completed', reportRel: 'final-report.md',
        fence: { owner: childRunId, generation: 2, intent: 'business' }, now: NOW1 + 3_000,
      });
      return { ok: true, usage: measuredUsage(30) };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'terminal-accounting-failed',
    reason: 'terminal-accounting-failed',
    usage: measuredUsage(30),
    recorded: false,
    accounting_reason: 'log-tampered',
  });
  const after = readState(root, runId).data;
  assert.equal(after.status, 'completed');
  assert.equal(after.budget.spent, 1);
  assert.equal(after.budget.tokens_spent, 0);
  assert.equal(readLines(root, runId).some(
    event => event.type === 'cost' && event.data.terminal_process === 'codex-maker',
  ), false);
});

test('invalid preflight usage cardinality fails closed before accounting or maker', () => {
  for (const { label, result: preflightResult, reason, invokeReceipts } of [
    { label: 'miss-zero', result: { ok: true, cache_hit: false, measured_usage: [] } },
    { label: 'miss-one', result: { ok: true, cache_hit: false, measured_usage: [measuredUsage(10)] } },
    {
      label: 'miss-three',
      result: { ok: true, cache_hit: false, measured_usage: [measuredUsage(10), measuredUsage(20), measuredUsage(30)] },
    },
    { label: 'hit-one', result: { ok: true, cache_hit: true, measured_usage: [measuredUsage(10)] } },
    {
      label: 'receipt-mode-invalid-usage',
      result: {
        ok: true,
        cache_hit: false,
        measured_usage: [measuredUsage(10), { num_turns: 2, input_tokens: 1, output_tokens: 1, tokens: 2 }],
        accounting_settled: true,
        accounting_receipts: ['a'.repeat(64), 'b'.repeat(64)],
      },
      reason: 'preflight-usage-invalid',
      invokeReceipts: true,
    },
    {
      label: 'receipt-mode-without-settlement-evidence',
      result: {
        ok: true,
        cache_hit: false,
        measured_usage: [measuredUsage(10), measuredUsage(20)],
        accounting_settled: true,
        accounting_receipts: ['c'.repeat(64), 'd'.repeat(64)],
      },
    },
    {
      label: 'failure-three',
      result: {
        ok: false,
        reason: 'write-smoke-failed',
        pause_mode: 'preserve',
        measured_usage: [measuredUsage(10), measuredUsage(20), measuredUsage(30)],
      },
    },
  ].map(item => ({ reason: 'preflight-invalid', invokeReceipts: false, ...item }))) {
    const { root, runId } = seedCodexHandoff();
    const deps = codexHostDeps(root, runId);
    let makerCalls = 0;
    const result = driveHeadlessRun({
      root,
      runId,
      expect: { owner: runId, generation: 1 },
      now: NOW1 + 1_000,
      ...deps,
      preflightFn: (options) => {
        if (invokeReceipts) {
          for (const receipt_id of preflightResult.accounting_receipts) {
            options.settleAccountingReceipt({ receipt_id });
          }
        }
        return preflightResult;
      },
      settlePreflightCostFn: () => ({ ok: true, recorded: true, reason: 'recorded' }),
      spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(40) }; },
    });

    assert.deepEqual(result, {
      ok: false,
      action: 'preflight-failed',
      reason,
    }, label);
    assert.equal(makerCalls, 0, label);
    assert.equal(readState(root, runId).data.status, 'paused', label);
    assert.equal(readLines(root, runId).filter((event) => event.type === 'cost').length, 0, label);
  }
});

test('failed preflight records zero, one, or two measured turns then preserve-pauses before CAS', () => {
  for (let usageCount = 0; usageCount <= 2; usageCount += 1) {
    const { root, runId, childRunId } = seedCodexHandoff();
    const deps = codexHostDeps(root, runId);
    const usages = [measuredUsage(10), measuredUsage(20)].slice(0, usageCount);
    let makerCalls = 0;
    const result = driveHeadlessRun({
      root,
      runId,
      now: NOW1 + 1_000,
      ...deps,
      preflightFn: () => ({
        ok: false,
        reason: 'write-smoke-failed',
        pause_mode: 'preserve',
        measured_usage: usages,
      }),
      spawnFn: () => {
        makerCalls += 1;
        return { ok: true, usage: measuredUsage(30) };
      },
    });

    assert.deepEqual(result, {
      ok: false,
      action: 'preflight-failed',
      reason: 'write-smoke-failed',
    }, `usageCount=${usageCount}`);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', `usageCount=${usageCount}`);
    assert.equal(after.pause_reason, 'write-smoke-failed', `usageCount=${usageCount}`);
    assert.equal(after.session_chain.lease.handoff_phase, 'emitted', `usageCount=${usageCount}`);
    assert.equal(after.session_chain.lease.handoff_child_run_id, childRunId, `usageCount=${usageCount}`);
    assert.equal(after.session_chain.lease.resume_policy, 'human', `usageCount=${usageCount}`);
    assert.equal(makerCalls, 0, `usageCount=${usageCount}`);
    const costs = readLines(root, runId).filter((event) => event.type === 'cost');
    assert.deepEqual(
      costs.map((event) => event.data.reported_tokens),
      usages.map((usage) => usage.tokens),
      `usageCount=${usageCount}`,
    );
  }
});

test('a failed preflight cache hint cannot suppress an already measured usage turn', () => {
  const { root, runId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  const result = driveHeadlessRun({
    root,
    runId,
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({
      ok: false,
      reason: 'write-smoke-failed',
      pause_mode: 'preserve',
      cache_hit: true,
      measured_usage: [measuredUsage(10)],
    }),
    spawnFn: () => { throw new Error('maker must not run'); },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'preflight-failed',
    reason: 'write-smoke-failed',
  });
  assert.deepEqual(
    readLines(root, runId).filter((event) => event.type === 'cost').map((event) => event.data.reported_tokens),
    [11],
  );
});

test('preliminary gate failure reaches respawn rollback without authentication, preflight, or maker', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const { data } = readState(root, runId);
  data.budget.total = 0;
  writeState(root, runId, data);
  let authCalls = 0;
  let preflightCalls = 0;
  let makerCalls = 0;

  const result = driveHeadlessRun({
    root,
    runId,
    now: NOW1 + 1_000,
    revalidateExecutable: () => { authCalls += 1; throw new Error('must not authenticate'); },
    resolveCodexHome: () => { authCalls += 1; throw new Error('must not authenticate'); },
    preflightFn: () => { preflightCalls += 1; throw new Error('must not preflight'); },
    spawnFn: () => { makerCalls += 1; throw new Error('must not spawn'); },
  });

  assert.deepEqual(result, { ok: false, action: 'gate-blocked', reason: 'budget' });
  assert.equal(authCalls, 0);
  assert.equal(preflightCalls, 0);
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.lease.handoff_child_run_id, null);
  assert.equal(
    after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
    'failed_launch',
  );
});

test('preliminary gate failure keeps a non-launching closure if the authoritative gate races open', () => {
  const { root, runId, childRunId } = seedClaudeHandoff();
  const { data } = readState(root, runId);
  data.circuit_breaker.tripped = true;
  writeState(root, runId, data);
  let makerCalls = 0;

  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    respawnFn: (projectRoot, id, options) => {
      const { data: fresh } = readState(projectRoot, id);
      fresh.circuit_breaker.tripped = false;
      writeState(projectRoot, id, fresh);
      return respawn(projectRoot, id, options);
    },
    spawnFn: () => {
      makerCalls += 1;
      throw new Error('preliminary-gate failure must never launch a process');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, 'fail-closed');
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.lease.handoff_child_run_id, null);
  assert.equal(
    after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
    'failed_launch',
  );
});

test('preflight cost can flip the authoritative respawn gate and block the maker', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  const { data } = readState(root, runId);
  data.budget.total = 2;
  writeState(root, runId, data);
  let makerCalls = 0;

  const result = driveHeadlessRun({
    root,
    runId,
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({
      ok: true,
      cache_hit: false,
      measured_usage: [measuredUsage(10), measuredUsage(20)],
    }),
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
  });

  assert.deepEqual(result, { ok: false, action: 'gate-blocked', reason: 'budget' });
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.lease.handoff_child_run_id, null);
  assert.equal(
    after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
    'failed_launch',
  );
  const costs = readLines(root, runId).filter((event) => event.type === 'cost');
  assert.deepEqual(costs.map((event) => event.data.reported_tokens), [11, 21]);
});

test('maker samples an injectable clock again after preflight and blocks at a crossed wallclock boundary', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  const { data } = readState(root, runId);
  data.budget.max_wallclock_sec = 62;
  writeState(root, runId, data);
  let clockCalls = 0;
  let preflightCalls = 0;
  let makerCalls = 0;

  const result = driveHeadlessRun({
    root,
    runId,
    ...deps,
    now: NOW0.getTime() + 61_999,
    clock: () => { clockCalls += 1; return NOW0.getTime() + 62_001; },
    preflightFn: () => {
      preflightCalls += 1;
      return { ok: true, cache_hit: true, measured_usage: [] };
    },
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
  });

  assert.deepEqual(result, { ok: false, action: 'gate-blocked', reason: 'wallclock' });
  assert.equal(clockCalls, 1, 'the CLI-shaped live clock must be sampled after preflight');
  assert.equal(preflightCalls, 1, 'the boundary must be crossed during preflight');
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(
    after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
    'failed_launch',
  );
});

test('Codex approval and CODEX_HOME authentication failures preserve-pause before preflight', () => {
  for (const failure of ['executable-invalid', 'codex-home-invalid']) {
    const { root, runId, childRunId } = seedCodexHandoff();
    const deps = codexHostDeps(root, runId);
    let preflightCalls = 0;
    let makerCalls = 0;
    const options = {
      root,
      runId,
      now: NOW1 + 1_000,
      ...deps,
      preflightFn: () => { preflightCalls += 1; throw new Error('must not preflight'); },
      spawnFn: () => { makerCalls += 1; throw new Error('must not spawn'); },
    };
    if (failure === 'executable-invalid') {
      options.revalidateExecutable = () => { throw new Error('RUNTIME_EXECUTABLE_DRIFT'); };
    } else {
      options.resolveCodexHome = () => { throw new Error('CODEX_HOME_DRIFT'); };
    }

    const result = driveHeadlessRun(options);
    assert.deepEqual(result, { ok: false, action: 'preflight-failed', reason: failure }, failure);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', failure);
    assert.equal(after.pause_reason, failure, failure);
    assert.equal(after.session_chain.lease.handoff_phase, 'emitted', failure);
    assert.equal(after.session_chain.lease.handoff_child_run_id, childRunId, failure);
    assert.equal(preflightCalls, 0, failure);
    assert.equal(makerCalls, 0, failure);
  }
});

test('invalid measured preflight usage preserve-pauses without recording or CAS', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({
      ok: true,
      cache_hit: false,
      measured_usage: [{ num_turns: 2, tokens: 99 }, measuredUsage(20)],
    }),
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'preflight-failed',
    reason: 'preflight-usage-invalid',
  });
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'preflight-usage-invalid');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(after.session_chain.lease.handoff_child_run_id, childRunId);
  assert.equal(makerCalls, 0);
  assert.equal(readLines(root, runId).filter((event) => event.type === 'cost').length, 0);
});

test('host rejects a stale explicit parent fence before authentication or preflight', () => {
  const { root, runId } = seedCodexHandoff();
  let sideEffects = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: 'STALE', generation: 0 },
    revalidateExecutable: () => { sideEffects += 1; throw new Error('must not authenticate'); },
    resolveCodexHome: () => { sideEffects += 1; throw new Error('must not authenticate'); },
    preflightFn: () => { sideEffects += 1; throw new Error('must not preflight'); },
    spawnFn: () => { sideEffects += 1; throw new Error('must not spawn'); },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'fenced',
    reason: 'caller-parent-fence-mismatch',
  });
  assert.equal(sideEffects, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'running');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('host carries the original parent fence through preflight into respawn', () => {
  const { root, runId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => {
      const { data } = readState(root, runId);
      data.session_chain.lease.owner_run_id = 'OTHER';
      data.session_chain.lease.generation = 2;
      writeState(root, runId, data);
      return { ok: true, cache_hit: true, measured_usage: [] };
    },
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'fenced',
    reason: 'caller-parent-fence-mismatch',
  });
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'running');
  assert.equal(after.session_chain.lease.owner_run_id, 'OTHER');
  assert.equal(after.session_chain.lease.generation, 2);
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('measured Codex maker without acquisition records against the parent before preserve-pause', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
    spawnFn: () => {
      makerCalls += 1;
      return { ok: true, usage: measuredUsage(30) };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'resumed-unconfirmed',
    reason: 'child-did-not-acquire',
    usage: measuredUsage(30),
    recorded: true,
  });
  assert.equal(makerCalls, 1);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'headless-child-did-not-acquire');
  assert.equal(after.session_chain.lease.handoff_phase, 'spawned');
  assert.equal(after.session_chain.lease.handoff_child_run_id, childRunId);
  assert.equal(after.session_chain.lease.resume_policy, 'human');
  const costs = readLines(root, runId).filter((event) => event.type === 'cost');
  assert.deepEqual(costs.map((event) => event.data.reported_tokens), [31]);
  assert.equal(costs[0].data.owner, runId);
  assert.equal(costs[0].data.generation, 1);
});

test('unrelated takeover is never accepted as the reserved child acquisition proof', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
    spawnFn: () => {
      const { data } = readState(root, runId);
      data.session_chain.lease.owner_run_id = 'UNRELATED';
      data.session_chain.lease.generation = 2;
      data.session_chain.lease.state = 'active';
      data.session_chain.lease.handoff_phase = 'acquired';
      writeState(root, runId, data);
      return { ok: true, usage: measuredUsage(30) };
    },
  });

  assert.equal(result.ok, false);
  assert.notEqual(result.action, 'resumed');
  assert.equal(result.recorded, false);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.sessions.find((session) => session.run_id === childRunId).started_at, null);
});

test('exact child acquisition remains proof after that child emits its next handoff', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
    spawnFn: () => {
      const acquired = acquireLease(root, runId, {
        owner: childRunId,
        expectGeneration: 1,
        runtime: 'codex',
        now: NOW1 + 2_000,
      });
      assert.equal(acquired.ok, true);
      const next = emitHandoff(root, runId, {
        trigger: 'next-milestone',
        headless: true,
        resumePolicy: 'headless',
        expect: { owner: childRunId, generation: 2 },
        now: NOW1 + 3_000,
      });
      assert.equal(next.ok, true);
      return { ok: true, usage: measuredUsage(30) };
    },
  });

  assert.deepEqual(result, {
    ok: true,
    action: 'resumed',
    usage: measuredUsage(30),
    recorded: true,
  });
  const after = readState(root, runId).data;
  assert.ok(after.session_chain.sessions.find((session) => session.run_id === childRunId).started_at);
  assert.equal(after.session_chain.lease.owner_run_id, childRunId);
  assert.equal(after.session_chain.lease.generation, 2);
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
  const costs = readLines(root, runId).filter((event) => event.type === 'cost');
  assert.deepEqual(costs.map((event) => event.data.reported_tokens), [31]);
  assert.equal(costs[0].data.owner, childRunId);
  assert.equal(costs[0].data.generation, 2);
});

test('spawned re-entry never retries preflight or maker and preserve-pauses when unconfirmed', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const before = readState(root, runId).data.session_chain.lease;
  const claim = advanceHandoffPhase(root, runId, {
    key: before.handoff_idempotency_key,
    toPhase: 'spawned',
    now: NOW1 + 1_000,
    expect: { owner: runId, generation: 1 },
  });
  assert.equal(claim.ok, true);
  let calls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 2_000,
    revalidateExecutable: () => { calls += 1; throw new Error('must not authenticate'); },
    resolveCodexHome: () => { calls += 1; throw new Error('must not authenticate'); },
    preflightFn: () => { calls += 1; throw new Error('must not preflight'); },
    spawnFn: () => { calls += 1; throw new Error('must not spawn'); },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'resumed-unconfirmed',
    reason: 'child-did-not-acquire',
    recorded: false,
  });
  assert.equal(calls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'spawned');
  assert.equal(after.session_chain.lease.handoff_child_run_id, childRunId);
  assert.equal(readLines(root, runId).filter((event) => event.type === 'cost').length, 0);
});

test('post-CAS timeout, parser failure, and non-zero exit each make one failed attempt with no retry', () => {
  for (const reason of ['timeout', 'jsonl-parser-failed', 'exit-17']) {
    const { root, runId, childRunId } = seedCodexHandoff();
    const deps = codexHostDeps(root, runId);
    let makerCalls = 0;
    const result = driveHeadlessRun({
      root,
      runId,
      expect: { owner: runId, generation: 1 },
      now: NOW1 + 1_000,
      timeoutMs: 54_321,
      ...deps,
      preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
      spawnFn: (_entry, options) => {
        makerCalls += 1;
        assert.equal(options.timeoutMs, 54_321, reason);
        assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'spawned', reason);
        return { ok: false, reason };
      },
    });

    assert.deepEqual(result, { ok: false, action: 'fail-closed', reason }, reason);
    assert.equal(makerCalls, 1, reason);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', reason);
    assert.equal(after.session_chain.lease.handoff_phase, 'idle', reason);
    assert.equal(after.session_chain.lease.handoff_child_run_id, null, reason);
    assert.equal(
      after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
      'failed_launch',
      reason,
    );
    assert.equal(readLines(root, runId).filter((event) => event.type === 'cost').length, 0, reason);

    const retry = driveHeadlessRun({
      root,
      runId,
      now: NOW1 + 2_000,
      spawnFn: () => { makerCalls += 1; throw new Error('must not retry'); },
    });
    assert.equal(retry.action, 'no-pending-handoff', reason);
    assert.equal(makerCalls, 1, reason);
  }
});

test('immediate executable and CODEX_HOME drift fail through respawn rollback before worker spawn', () => {
  for (const drift of ['executable', 'codex-home']) {
    const { root, runId, childRunId } = seedCodexHandoff();
    const { executable, codexHome, env } = codexHostDeps(root, runId);
    let executableChecks = 0;
    let homeChecks = 0;
    let makerCalls = 0;
    const result = driveHeadlessRun({
      root,
      runId,
      expect: { owner: runId, generation: 1 },
      now: NOW1 + 1_000,
      env,
      revalidateExecutable: () => {
        executableChecks += 1;
        if (drift === 'executable' && executableChecks === 2) throw new Error('RUNTIME_EXECUTABLE_DRIFT');
        return executable;
      },
      resolveCodexHome: () => {
        homeChecks += 1;
        if (drift === 'codex-home' && homeChecks === 2) throw new Error('CODEX_HOME_DRIFT');
        return codexHome;
      },
      preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
      spawnFn: () => { makerCalls += 1; throw new Error('worker must not run after drift'); },
    });

    assert.deepEqual(result, {
      ok: false,
      action: 'fail-closed',
      reason: 'post-cas-identity-drift',
    }, drift);
    assert.equal(makerCalls, 0, drift);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', drift);
    assert.equal(after.session_chain.lease.handoff_phase, 'idle', drift);
    assert.equal(after.session_chain.lease.handoff_child_run_id, null, drift);
    assert.equal(
      after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
      'failed_launch',
      drift,
    );
  }
});

test('driveHeadless is a current-run compatibility wrapper over the injected core', () => {
  const { root, runId } = seedClaudeHandoff();
  let captured = null;
  const sentinel = { ok: true, action: 'injected-core' };
  const result = driveHeadless({
    root,
    now: NOW1 + 1_000,
    timeoutMs: 9876,
    driveRun: (options) => {
      captured = options;
      return sentinel;
    },
  });
  assert.equal(result, sentinel);
  assert.equal(captured.root, root);
  assert.equal(captured.runId, runId);
  assert.equal(captured.now, NOW1 + 1_000);
  assert.equal(captured.timeoutMs, 9876);

  const emptyRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dl-headless-host-empty-')));
  let called = false;
  assert.deepEqual(driveHeadless({
    root: emptyRoot,
    driveRun: () => { called = true; throw new Error('must not call core'); },
  }), { ok: true, action: 'no-run' });
  assert.equal(called, false);
});

test('a host policy override never bypasses fail-closed human resume intent', () => {
  const { root, runId } = seedClaudeHandoff();
  const { data } = readState(root, runId);
  data.session_chain.lease.resume_policy = 'human';
  writeState(root, runId, data);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    overrideVisiblePolicy: true,
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: { num_turns: 1, tokens: 1 } }; },
  });
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'human-resume-policy' });
  assert.equal(makerCalls, 0);
});

test('Claude uses the same core without Codex auth/preflight and keeps acquisition accounting', () => {
  const { root, runId, childRunId } = seedClaudeHandoff();
  let codexCalls = 0;
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    revalidateExecutable: () => { codexCalls += 1; throw new Error('must skip Codex auth'); },
    resolveCodexHome: () => { codexCalls += 1; throw new Error('must skip Codex home'); },
    preflightFn: () => { codexCalls += 1; throw new Error('must skip Codex preflight'); },
    spawnFn: (entry) => {
      makerCalls += 1;
      assert.equal(entry.bin, 'claude');
      acquireLease(root, runId, {
        owner: childRunId,
        expectGeneration: 1,
        runtime: 'claude',
        now: NOW1 + 2_000,
      });
      return { ok: true, usage: { num_turns: 2, tokens: 50 } };
    },
  });
  assert.deepEqual(result, {
    ok: true,
    action: 'resumed',
    usage: { num_turns: 2, tokens: 50 },
    recorded: true,
  });
  assert.equal(codexCalls, 0);
  assert.equal(makerCalls, 1);
  assert.equal(readState(root, runId).data.budget.spent, 2);
});

test('Claude keeps legacy no-acquire semantics: pause without recording measured usage', () => {
  const { root, runId } = seedClaudeHandoff();
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    spawnFn: () => ({ ok: true, usage: { num_turns: 2, tokens: 50 } }),
  });
  assert.deepEqual(result, {
    ok: false,
    action: 'resumed-unconfirmed',
    reason: 'child-did-not-acquire',
  });
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.budget.spent, 0);
});

test('host preserves outer headless selection as a mode fence instead of forcing a changed inner mode', () => {
  const { root, runId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    headless: false,
    now: NOW1 + 1_000,
    env: {},
    ...deps,
    preflightFn: () => {
      const { data } = readState(root, runId);
      data.autonomy.spawn_style = 'visible';
      writeState(root, runId, data);
      return { ok: true, cache_hit: true, measured_usage: [] };
    },
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'mode-changed',
    reason: 'spawn-mode-changed:headless->interactive',
  });
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'running');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('preflight accounting fence loss stops before CAS and never adopts the new owner', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let records = 0;
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({
      ok: true,
      cache_hit: false,
      measured_usage: [measuredUsage(10), measuredUsage(20)],
    }),
    recordCostFn: (projectRoot, id, options) => {
      const recorded = recordCost(projectRoot, id, options);
      records += 1;
      if (records === 1) {
        const { data } = readState(root, runId);
        data.session_chain.lease.owner_run_id = 'OTHER';
        data.session_chain.lease.generation = 2;
        writeState(root, runId, data);
      }
      return recorded;
    },
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'fenced',
    reason: 'accounting-fenced',
    recorded: 1,
  });
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'running');
  assert.equal(after.session_chain.lease.owner_run_id, 'OTHER');
  assert.equal(after.session_chain.lease.generation, 2);
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(after.session_chain.lease.handoff_child_run_id, childRunId);
  const costs = readLines(root, runId).filter((event) => event.type === 'cost');
  assert.deepEqual(costs.map((event) => event.data.reported_tokens), [11]);
});

test('preflight failure never refreshes a stale parent fence to pause a new owner', () => {
  const { root, runId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => {
      const { data } = readState(root, runId);
      data.session_chain.lease.owner_run_id = 'OTHER';
      data.session_chain.lease.generation = 2;
      writeState(root, runId, data);
      return {
        ok: false,
        reason: 'read-smoke-failed',
        pause_mode: 'preserve',
        measured_usage: [],
      };
    },
    spawnFn: () => { throw new Error('must not spawn'); },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'fenced',
    reason: 'read-smoke-failed',
  });
  const after = readState(root, runId).data;
  assert.equal(after.status, 'running');
  assert.equal(after.session_chain.lease.owner_run_id, 'OTHER');
  assert.equal(after.session_chain.lease.generation, 2);
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('concurrent terminal transition during preflight failure is never demoted to paused', () => {
  const { root, runId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => {
      const { data } = readState(root, runId);
      data.status = 'completed';
      writeState(root, runId, data);
      return {
        ok: false,
        reason: 'read-smoke-failed',
        pause_mode: 'preserve',
        measured_usage: [],
      };
    },
    spawnFn: () => { throw new Error('must not spawn'); },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'fail-closed-terminal',
    reason: 'read-smoke-failed',
  });
  assert.equal(readState(root, runId).data.status, 'completed');
});

test('post-CAS validation rejects stored approval metadata drift even when executable identity revalidates', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => {
      const { data } = readState(root, runId);
      data.autonomy.runtime_executable_approval.approved_at = '2026-07-11T00:00:01.000Z';
      writeState(root, runId, data);
      return { ok: true, cache_hit: true, measured_usage: [] };
    },
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'fail-closed',
    reason: 'post-cas-identity-drift',
  });
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(
    after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
    'failed_launch',
  );
});

test('preflight throw and invalid return are normalized at the host boundary and preserve-pause', () => {
  for (const { label, preflightFn, reason } of [
    { label: 'throw', preflightFn: () => { throw new Error('unexpected preflight crash'); }, reason: 'preflight-error' },
    { label: 'null', preflightFn: () => null, reason: 'preflight-invalid' },
    { label: 'array', preflightFn: () => [], reason: 'preflight-invalid' },
    { label: 'missing reason', preflightFn: () => ({ ok: false, measured_usage: [] }), reason: 'preflight-invalid' },
  ]) {
    const { root, runId, childRunId } = seedCodexHandoff();
    const deps = codexHostDeps(root, runId);
    let makerCalls = 0;
    const result = driveHeadlessRun({
      root,
      runId,
      expect: { owner: runId, generation: 1 },
      now: NOW1 + 1_000,
      ...deps,
      preflightFn,
      spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
    });

    assert.deepEqual(result, { ok: false, action: 'preflight-failed', reason }, label);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', label);
    assert.equal(after.pause_reason, reason, label);
    assert.equal(after.session_chain.lease.handoff_phase, 'emitted', label);
    assert.equal(after.session_chain.lease.handoff_child_run_id, childRunId, label);
    assert.equal(makerCalls, 0, label);
  }
});

test('post-CAS validation rejects allowlisted environment drift after preflight', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => {
      deps.env.PATH = '/unproved/path';
      return { ok: true, cache_hit: true, measured_usage: [] };
    },
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'fail-closed',
    reason: 'post-cas-env-drift',
  });
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(
    after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
    'failed_launch',
  );
});

test('terminal Codex handoff returns before authentication, preflight, or maker', () => {
  const { root, runId } = seedCodexHandoff();
  const { data } = readState(root, runId);
  data.status = 'completed';
  writeState(root, runId, data);
  let calls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    revalidateExecutable: () => { calls += 1; throw new Error('must not authenticate'); },
    resolveCodexHome: () => { calls += 1; throw new Error('must not authenticate'); },
    preflightFn: () => { calls += 1; throw new Error('must not preflight'); },
    spawnFn: () => { calls += 1; throw new Error('must not spawn'); },
  });

  assert.deepEqual(result, { ok: false, action: 'terminal', reason: 'RUN_TERMINAL' });
  assert.equal(calls, 0);
  assert.equal(readState(root, runId).data.status, 'completed');
});

test('concurrent spawned CAS loss never reports success without exact child acquisition', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
    respawnFn: (projectRoot, id, options) => {
      const claim = advanceHandoffPhase(projectRoot, id, {
        key: options.key,
        toPhase: 'spawned',
        now: NOW1 + 1_500,
        expect: { owner: runId, generation: 1 },
      });
      assert.equal(claim.ok, true);
      return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
    },
    spawnFn: () => { makerCalls += 1; throw new Error('must not spawn after losing CAS'); },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'resumed-unconfirmed',
    reason: 'child-did-not-acquire',
    recorded: false,
  });
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'spawned');
  assert.equal(after.session_chain.lease.handoff_child_run_id, childRunId);
});

test('post-CAS validation rejects project or plugin directory node replacement before maker', () => {
  for (const replaced of ['project', 'plugin']) {
    const { root, runId, childRunId } = seedCodexHandoff();
    const deps = codexHostDeps(root, runId);
    const callsByPath = new Map();
    let makerCalls = 0;
    const result = driveHeadlessRun({
      root,
      runId,
      expect: { owner: runId, generation: 1 },
      now: NOW1 + 1_000,
      deepLoopRoot: '/opt/deep-loop-plugin',
      ...deps,
      inspectDirectory: (path) => {
        const count = (callsByPath.get(path) || 0) + 1;
        callsByPath.set(path, count);
        const kind = path === root ? 'project' : 'plugin';
        return { canonical_path: path, device: kind, inode: count > 1 && kind === replaced ? 'replaced' : 'stable', mode: '16877' };
      },
      inspectResumeSkill: (path) => ({
        canonical_path: path,
        device: '1', inode: '2', mode: '33188', size: '100', mtime_ns: '3', ctime_ns: '4',
        sha256: 'a'.repeat(64),
      }),
      preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
      spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
    });

    assert.deepEqual(result, {
      ok: false,
      action: 'fail-closed',
      reason: 'post-cas-root-drift',
    }, replaced);
    assert.equal(makerCalls, 0, replaced);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', replaced);
    assert.equal(after.session_chain.lease.handoff_phase, 'idle', replaced);
    assert.equal(
      after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
      'failed_launch',
      replaced,
    );
  }
});

test('post-CAS validation rejects exact resume-skill replacement before maker', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let skillChecks = 0;
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    inspectResumeSkill: (path) => {
      skillChecks += 1;
      return {
        canonical_path: path,
        device: '1',
        inode: '2',
        mode: '33188',
        size: '100',
        mtime_ns: '3',
        ctime_ns: '4',
        sha256: skillChecks === 1 ? 'a'.repeat(64) : 'b'.repeat(64),
      };
    },
    preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
    spawnFn: () => { makerCalls += 1; return { ok: true, usage: measuredUsage(30) }; },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'fail-closed',
    reason: 'post-cas-resume-skill-drift',
  });
  assert.equal(skillChecks, 2);
  assert.equal(makerCalls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(
    after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
    'failed_launch',
  );
});

test('fresh initial mode mismatch returns before authentication, preflight, or maker', () => {
  const { root, runId } = seedCodexHandoff();
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'visible';
  writeState(root, runId, data);
  let calls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    headless: false,
    env: {},
    revalidateExecutable: () => { calls += 1; throw new Error('must not authenticate'); },
    resolveCodexHome: () => { calls += 1; throw new Error('must not authenticate'); },
    preflightFn: () => { calls += 1; throw new Error('must not preflight'); },
    spawnFn: () => { calls += 1; throw new Error('must not spawn'); },
  });

  assert.deepEqual(result, {
    ok: false,
    action: 'mode-changed',
    reason: 'spawn-mode-changed:headless->interactive',
  });
  assert.equal(calls, 0);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'running');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('malformed worker result objects fail closed once and never report resume success', () => {
  for (const { label, workerResult } of [
    { label: 'missing ok', workerResult: {} },
    { label: 'string ok', workerResult: { ok: 'true' } },
    { label: 'success without usage', workerResult: { ok: true } },
    { label: 'failure without reason', workerResult: { ok: false } },
  ]) {
    const { root, runId, childRunId } = seedCodexHandoff();
    const deps = codexHostDeps(root, runId);
    let makerCalls = 0;
    const result = driveHeadlessRun({
      root,
      runId,
      expect: { owner: runId, generation: 1 },
      now: NOW1 + 1_000,
      ...deps,
      preflightFn: () => ({ ok: true, cache_hit: true, measured_usage: [] }),
      spawnFn: () => {
        makerCalls += 1;
        assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'spawned');
        return workerResult;
      },
    });

    assert.deepEqual(result, {
      ok: false,
      action: 'fail-closed',
      reason: 'worker-protocol-invalid',
    }, label);
    assert.equal(makerCalls, 1, label);
    const after = readState(root, runId).data;
    assert.equal(after.status, 'paused', label);
    assert.equal(after.session_chain.lease.handoff_phase, 'idle', label);
    assert.equal(
      after.session_chain.sessions.find((session) => session.run_id === childRunId).outcome,
      'failed_launch',
      label,
    );
  }
});

test('a concurrent host entry is serialized before Codex preflight and cannot double-record', () => {
  const { root, runId, childRunId } = seedCodexHandoff();
  const deps = codexHostDeps(root, runId);
  let preflightCalls = 0;
  let makerCalls = 0;
  let nestedResult;
  let options;
  options = {
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    ...deps,
    preflightFn: () => {
      preflightCalls += 1;
      if (preflightCalls === 1) nestedResult = driveHeadlessRun(options);
      return {
        ok: true,
        cache_hit: false,
        measured_usage: [measuredUsage(10), measuredUsage(20)],
      };
    },
    spawnFn: () => {
      makerCalls += 1;
      acquireLease(root, runId, {
        owner: childRunId,
        expectGeneration: 1,
        runtime: 'codex',
        now: NOW1 + 2_000,
      });
      return { ok: true, usage: measuredUsage(30) };
    },
  };

  const result = driveHeadlessRun(options);
  assert.deepEqual(nestedResult, { ok: true, action: 'already-driving' });
  assert.equal(preflightCalls, 1);
  assert.equal(makerCalls, 1);
  assert.deepEqual(result, {
    ok: true,
    action: 'resumed',
    usage: measuredUsage(30),
    recorded: true,
  });
  assert.deepEqual(
    readLines(root, runId).filter((event) => event.type === 'cost').map((event) => event.data.reported_tokens),
    [11, 21, 31],
  );
});

test('an owner-missing host lock is reclaimed after the short metadata crash grace', () => {
  const { root, runId, childRunId } = seedClaudeHandoff();
  const lockPath = join(runDir(root, runId), '.headless-host.lock');
  mkdirSync(lockPath);
  const wallNow = Date.parse('2026-07-11T12:00:00Z');
  const staleAt = new Date(wallNow - 31 * 1000);
  utimesSync(lockPath, staleAt, staleAt);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    timeoutMs: 0,
    lockWallNow: () => wallNow,
    spawnFn: () => {
      makerCalls += 1;
      acquireLease(root, runId, {
        owner: childRunId,
        expectGeneration: 1,
        runtime: 'claude',
        now: NOW1 + 2_000,
      });
      return { ok: true, usage: { num_turns: 1, tokens: 1 } };
    },
  });
  assert.equal(result.action, 'resumed');
  assert.equal(makerCalls, 1);
  assert.equal(existsSync(lockPath), false);
});

test('a malformed-owner host lock is reclaimed after the short metadata crash grace', () => {
  const { root, runId, childRunId } = seedClaudeHandoff();
  const lockPath = join(runDir(root, runId), '.headless-host.lock');
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner'), 'not-json');
  const wallNow = Date.parse('2026-07-11T12:00:00Z');
  const staleAt = new Date(wallNow - 31 * 1000);
  utimesSync(lockPath, staleAt, staleAt);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    timeoutMs: 0,
    lockWallNow: () => wallNow,
    spawnFn: () => {
      makerCalls += 1;
      acquireLease(root, runId, {
        owner: childRunId,
        expectGeneration: 1,
        runtime: 'claude',
        now: NOW1 + 2_000,
      });
      return { ok: true, usage: { num_turns: 1, tokens: 1 } };
    },
  });
  assert.equal(result.action, 'resumed');
  assert.equal(makerCalls, 1);
  assert.equal(existsSync(lockPath), false);
});

test('a dead-PID host lock is reclaimed after the short metadata crash grace', () => {
  const { root, runId, childRunId } = seedClaudeHandoff();
  const lockPath = join(runDir(root, runId), '.headless-host.lock');
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner'), JSON.stringify({
    token: 'dead-host-token',
    pid: 424_242,
    started_at_ms: 0,
  }));
  const wallNow = Date.parse('2026-07-11T12:00:00Z');
  const staleAt = new Date(wallNow - 31 * 1000);
  utimesSync(lockPath, staleAt, staleAt);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    timeoutMs: 0,
    lockWallNow: () => wallNow,
    hostProcessAlive: () => false,
    spawnFn: () => {
      makerCalls += 1;
      acquireLease(root, runId, {
        owner: childRunId,
        expectGeneration: 1,
        runtime: 'claude',
        now: NOW1 + 2_000,
      });
      return { ok: true, usage: { num_turns: 1, tokens: 1 } };
    },
  });
  assert.equal(result.action, 'resumed');
  assert.equal(makerCalls, 1);
  assert.equal(existsSync(lockPath), false);
});

test('a live-PID host lock is reclaimed after the timeout-derived hard stale bound', () => {
  const { root, runId, childRunId } = seedClaudeHandoff();
  const lockPath = join(runDir(root, runId), '.headless-host.lock');
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner'), JSON.stringify({
    token: 'old-host-token',
    pid: process.pid,
    started_at_ms: 0,
  }));
  const wallNow = Date.parse('2026-07-11T12:00:00Z');
  const staleAt = new Date(wallNow - 16 * 60 * 1000);
  utimesSync(lockPath, staleAt, staleAt);
  let makerCalls = 0;
  const result = driveHeadlessRun({
    root,
    runId,
    expect: { owner: runId, generation: 1 },
    now: NOW1 + 1_000,
    timeoutMs: 0,
    lockWallNow: () => wallNow,
    hostProcessAlive: () => true,
    spawnFn: () => {
      makerCalls += 1;
      acquireLease(root, runId, {
        owner: childRunId,
        expectGeneration: 1,
        runtime: 'claude',
        now: NOW1 + 2_000,
      });
      return { ok: true, usage: { num_turns: 1, tokens: 1 } };
    },
  });
  assert.equal(result.action, 'resumed');
  assert.equal(makerCalls, 1);
  assert.equal(existsSync(lockPath), false);
});
