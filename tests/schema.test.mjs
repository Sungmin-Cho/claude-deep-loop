import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CHECKER_PROCESS_PHASES,
  CHECKER_PROCESS_REASON_CODES,
  loadSchema,
  validate,
  validCheckerIdentityDiagnostic,
  validCheckerImportDiagnostic,
  validCheckerProcessDiagnostic,
} from '../scripts/lib/schema.mjs';
import { buildInitialLoop } from '../scripts/lib/initrun.mjs';
import { classifyPatch } from '../scripts/lib/state.mjs';

function minimalValid() {
  return {
    schema_version: '0.4.0', run_id: 'R', goal: 'g', status: 'running',
    project: { binding_generation: 1 }, routing: { protocol: 'deep-work' }, review: {}, autonomy: { tier: 'recommend', spawn_style: 'interactive', continuation_policy: 'workstream-session', attended_launch_approval: null },
    budget: { unit: 'turns' }, comprehension: {}, circuit_breaker: {},
    session_chain: { lease: { state: 'active', handoff_phase: 'idle', handoff_trigger: null, takeover_kind: null }, consumed_milestones: [], sessions: [] },
    workstreams: [], active_workstreams: [], triage: {}, episodes: [], termination: {},
  };
}

const digest = value => createHash('sha256').update(value).digest('hex');

function dualAggregationLoop({ approved = false } = {}) {
  const loop = minimalValid();
  loop.schema_version = '0.5.0';
  const sourceWithoutDigest = {
    run_id: 'R', checker_episode_id: 'checker', target_maker: 'maker',
    workstream_id: 'ws', point: 'implementation', project_root: '/repo',
    runtime: 'codex', lease_owner: 'OWNER', lease_generation: 1,
    artifacts: [{ path: 'worktree/artifact.txt', sha256: 'a'.repeat(64) }],
  };
  const sourceClaimSha256 = digest(JSON.stringify(sourceWithoutDigest));
  const attempts = [
    {
      slot: 0, attempt_id: 'attempt-one', reviewer_id: 'deep-review',
      reviewer_adapter: 'codex-checker', provider_id: 'openai-codex',
      model_id: 'gpt-5.6-sol', session_id: null,
      source_claim_sha256: sourceClaimSha256, status: 'claimed',
      capture_proof: null, process_proof: null, report_proof: null, cost_proof: null,
    },
    {
      slot: 1, attempt_id: 'attempt-two', reviewer_id: 'grok-review',
      reviewer_adapter: 'grok-checker', provider_id: 'xai-grok',
      model_id: 'grok-4.6', session_id: null,
      source_claim_sha256: sourceClaimSha256, status: 'claimed',
      capture_proof: null, process_proof: null, report_proof: null, cost_proof: null,
    },
  ];
  const aggregation = {
    schema_version: '2.0', policy: 'ALL_LITERAL_APPROVE_2',
    aggregation_id: 'aggregation-11111111-1111-4111-8111-111111111111',
    required_attempt_count: 2, aggregate_status: 'in_progress',
    source_binding: { ...sourceWithoutDigest, source_claim_sha256: sourceClaimSha256 },
    attempts, aggregate_proof: null,
  };
  if (approved) {
    for (const [index, attempt] of attempts.entries()) {
      const suffix = String(index + 1);
      const captureBinding = {
        run_id: 'R',
        checker_episode_id: 'checker',
        attempt_id: attempt.attempt_id,
        source_claim_sha256: sourceClaimSha256,
        record_path: `.deep-loop/runs/R/checker-captures/${suffix}/capture.json`,
        record_sha256: suffix.repeat(64),
        manifest_path: `.deep-loop/runs/R/checker-captures/${suffix}/plugin.json`,
        source_manifest_sha256: '3'.repeat(64),
        skill_path: `.deep-loop/runs/R/checker-captures/${suffix}/SKILL.md`,
        source_skill_sha256: '5'.repeat(64),
      };
      attempt.session_id = index === 0
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222';
      attempt.capture_proof = {
        capture_id: digest(JSON.stringify(captureBinding)), ...captureBinding,
      };
      attempt.process_proof = {
        receipt_id: `${index + 7}`.repeat(64),
        receipt: `.deep-loop/runs/R/preflight/process-receipts/${suffix}.json`,
        provider_id: attempt.provider_id, model_id: attempt.model_id,
        session_id: attempt.session_id, claim_hash: (index === 0 ? '9' : 'b').repeat(64),
        stdout_sha256: `${index + 1}`.repeat(64), stderr_sha256: `${index + 2}`.repeat(64),
      };
      attempt.cost_proof = {
        receipt_id: attempt.process_proof.receipt_id,
        event_seq: 10 + index, event_checksum: `${index + 3}`.repeat(64),
        usage: { num_turns: 1, input_tokens: 3, output_tokens: 2, tokens: 5 },
      };
      attempt.report_proof = {
        verdict: 'APPROVE',
        report: `.deep-loop/runs/R/reviews/${index + 4}.json`,
        report_sha256: `${index + 4}`.repeat(64),
        event_seq: 20 + index, event_checksum: `${index + 5}`.repeat(64),
      };
      attempt.status = 'imported';
    }
    aggregation.aggregate_status = 'approved';
    aggregation.aggregate_proof = {
      source_claim_sha256: sourceClaimSha256,
      attempt_ids: attempts.map(attempt => attempt.attempt_id),
      report_hashes: attempts.map(attempt => attempt.report_proof.report_sha256),
      process_receipt_ids: attempts.map(attempt => attempt.process_proof.receipt_id),
      cost_event_seqs: attempts.map(attempt => attempt.cost_proof.event_seq),
      capture_hashes: attempts.map(attempt => attempt.capture_proof.record_sha256),
      final_event_seq: 30, final_event_checksum: 'f'.repeat(64),
    };
  }
  loop.episodes = [{
    id: 'checker', role: 'checker', plugin: 'deep-review',
    status: approved ? 'approved' : 'in_progress',
    request_rel: 'episodes/checker/request.md', review_aggregation: aggregation,
  }];
  return loop;
}

function validActivationReceipt() {
  return {
    owner_run_id: 'OWNER',
    generation: 2,
    from_generation: 1,
    to_generation: 2,
    attempt_id: 'attempt-001',
    activation_token_digest: 'a'.repeat(64),
    activated_at: '2026-08-05T00:00:00.000Z',
  };
}

function validExpiryReceipt() {
  return {
    decision_kind: 'activation-expiry',
    evidence_kind: 'kernel-activation-deadline',
    authority: 'kernel-clock',
    transition: 'preserve-pause',
    run_id: 'RUN',
    subject_owner_run_id: 'OWNER',
    subject_attempt_id: 'attempt-001',
    subject_from_generation: 1,
    subject_to_generation: 2,
    deadline_at: '2026-08-05T00:00:00.000Z',
    decided_at: '2026-08-05T00:15:00.000Z',
  };
}

const OPEN_WORKSTREAM_SCOPE = Object.freeze({
  kind: 'workstream', workstream_id: null, bound_at_seq: null, terminal_event: null,
  closed_at: null, superseded_at: null,
});

test('valid loop.json passes', () => {
  assert.equal(validate(minimalValid()).ok, true);
});

test('v0.5 dual aggregation requires the exact closed 2.0 claim shape and null claim-time sessions', () => {
  const valid = dualAggregationLoop();
  assert.equal(validate(valid).ok, true, validate(valid).errors.join('; '));
  for (const [label, mutate] of [
    ['missing policy', value => { delete value.policy; }],
    ['wrong envelope version', value => { value.schema_version = '1.0'; }],
    ['wrong attempt count', value => { value.required_attempt_count = 1; }],
    ['slot collision', value => { value.attempts[1].slot = 0; }],
    ['reviewer collision', value => { value.attempts[1].reviewer_id = value.attempts[0].reviewer_id; }],
    ['adapter collision', value => { value.attempts[1].reviewer_adapter = value.attempts[0].reviewer_adapter; }],
    ['provider collision', value => { value.attempts[1].provider_id = value.attempts[0].provider_id; }],
    ['model collision', value => { value.attempts[1].model_id = value.attempts[0].model_id; }],
    ['slot route swap', value => {
      for (const key of ['reviewer_id', 'reviewer_adapter', 'provider_id', 'model_id']) {
        [value.attempts[0][key], value.attempts[1][key]] = [value.attempts[1][key], value.attempts[0][key]];
      }
    }],
    ['untrusted claim session', value => { value.attempts[0].session_id = '11111111-1111-4111-8111-111111111111'; }],
    ['source digest drift', value => { value.source_binding.source_claim_sha256 = 'f'.repeat(64); }],
    ['empty source artifacts', value => {
      value.source_binding.artifacts = [];
      const { source_claim_sha256: _digest, ...source } = value.source_binding;
      value.source_binding.source_claim_sha256 = digest(JSON.stringify(source));
      for (const attempt of value.attempts) {
        attempt.source_claim_sha256 = value.source_binding.source_claim_sha256;
      }
    }],
    ['legacy source evidence is not part of the exact v2 source binding', value => {
      value.source_binding.evidence = {
        insights_path: '.deep-loop/insights/01TEST-insights.json', emit_ulid: '01TEST',
        producer_run_id: 'R', sha256: 'b'.repeat(64), candidates: [],
      };
      const { source_claim_sha256: _digest, ...source } = value.source_binding;
      value.source_binding.source_claim_sha256 = digest(JSON.stringify(source));
      for (const attempt of value.attempts) {
        attempt.source_claim_sha256 = value.source_binding.source_claim_sha256;
      }
    }],
    ['extra aggregate key', value => { value.synthetic_report = 'forbidden'; }],
  ]) {
    const candidate = structuredClone(valid);
    mutate(candidate.episodes[0].review_aggregation);
    assert.equal(validate(candidate).ok, false, label);
  }
  const legacy = structuredClone(valid);
  legacy.schema_version = '0.4.0';
  assert.equal(validate(legacy).ok, false, 'legacy scalar state cannot carry dual evidence');

  const blocked = structuredClone(valid);
  blocked.episodes[0].status = 'blocked';
  blocked.episodes[0].review_aggregation.aggregate_status = 'blocked';
  assert.equal(validate(blocked).ok, true, validate(blocked).errors.join('; '));
  blocked.episodes[0].status = 'in_progress';
  assert.equal(validate(blocked).ok, false, 'blocked aggregate must also block the outer checker');
});

test('approved dual aggregate binds two distinct exact capture/process/report/cost proofs', () => {
  const valid = dualAggregationLoop({ approved: true });
  assert.equal(validate(valid).ok, true, validate(valid).errors.join('; '));
  for (const [label, mutate] of [
    ['session collision', value => { value.attempts[1].session_id = value.attempts[0].session_id; value.attempts[1].process_proof.session_id = value.attempts[0].session_id; }],
    ['capture collision', value => { value.attempts[1].capture_proof = structuredClone(value.attempts[0].capture_proof); }],
    ['process collision', value => { value.attempts[1].process_proof.receipt_id = value.attempts[0].process_proof.receipt_id; value.attempts[1].cost_proof.receipt_id = value.attempts[0].process_proof.receipt_id; }],
    ['report collision', value => { value.attempts[1].report_proof.report_sha256 = value.attempts[0].report_proof.report_sha256; }],
    ['cost collision', value => { value.attempts[1].cost_proof.event_seq = value.attempts[0].cost_proof.event_seq; }],
    ['missing cost', value => { value.attempts[1].cost_proof = null; }],
    ['non-approve', value => { value.attempts[1].report_proof.verdict = 'CONCERN'; }],
    ['aggregate report mismatch', value => { value.aggregate_proof.report_hashes[1] = 'e'.repeat(64); }],
    ['premature outer status', value => { value.aggregate_status = 'in_progress'; value.aggregate_proof = null; }],
  ]) {
    const candidate = structuredClone(valid);
    mutate(candidate.episodes[0].review_aggregation);
    assert.equal(validate(candidate).ok, false, label);
  }
});

test('schema registry includes activation lifecycle event kinds', () => {
  const schema = loadSchema();
  assert.ok(schema.event_types.includes('lease-activated'));
  assert.ok(schema.event_types.includes('activation-expired'));
});

test('checker process diagnostic is backward-compatible but exact, closed, and path-free when present', () => {
  const stream = { sha256: 'a'.repeat(64), byte_count: 0, truncated: false };
  const diagnostic = {
    reason_code: 'child-nonzero-exit',
    process_phase: 'child-execution',
    stderr: stream,
    stdout: { sha256: 'b'.repeat(64), byte_count: 17, truncated: true },
  };
  assert.equal(validCheckerProcessDiagnostic(diagnostic), true);
  assert.ok(CHECKER_PROCESS_REASON_CODES.includes(diagnostic.reason_code));
  assert.ok(CHECKER_PROCESS_PHASES.includes(diagnostic.process_phase));

  const absent = minimalValid();
  absent.episodes.push({ id: '001-checker', status: 'blocked', request_rel: 'episodes/001-checker/request.md' });
  assert.equal(validate(absent).ok, true, 'legacy episode without diagnostic remains valid');

  const present = structuredClone(absent);
  present.episodes[0].checker_process_diagnostic = diagnostic;
  assert.equal(validate(present).ok, true);

  const mutants = [
    ['missing stdout', value => { delete value.stdout; }],
    ['raw stderr', value => { value.stderr.raw = 'SECRET'; }],
    ['attacker path', value => { value.path = '/tmp/secret'; }],
    ['extra argv', value => { value.argv = ['--secret']; }],
    ['open reason', value => { value.reason_code = 'exit-37:/secret'; }],
    ['prototype reason', value => { value.reason_code = 'toString'; }],
    ['open phase', value => { value.process_phase = 'attacker-phase'; }],
    ['negative count', value => { value.stderr.byte_count = -1; }],
    ['non-canonical hash', value => { value.stderr.sha256 = 'A'.repeat(64); }],
    ['non-boolean truncation', value => { value.stderr.truncated = 0; }],
  ];
  for (const [label, mutate] of mutants) {
    const candidate = structuredClone(present);
    mutate(candidate.episodes[0].checker_process_diagnostic);
    assert.equal(validate(candidate).ok, false, label);
  }

  const validPairs = [
    ['process-config-invalid', 'request'],
    ['child-spawn-failed', 'child-spawn'],
    ['child-timeout', 'child-execution'],
    ['child-nonzero-exit', 'child-execution'],
    ['child-stdin-failed', 'child-stdin'],
    ['child-output-overflow', 'child-protocol'],
    ['child-protocol-invalid', 'child-protocol'],
    ['usage-unmeasurable', 'usage-parse'],
    ['usage-receipt-write-failed', 'receipt-write'],
    ['worker-request-invalid', 'request'],
    ['worker-request-overflow', 'request'],
    ['worker-spawn-failed', 'worker-spawn'],
    ['worker-timeout', 'worker-transport'],
    ['worker-result-overflow', 'worker-transport'],
    ['worker-terminated', 'worker-transport'],
    ['worker-nonzero-exit', 'worker-transport'],
    ['worker-protocol-invalid', 'worker-transport'],
    ['checker-worker-invalid', 'checker-adapter'],
    ['checker-usage-invalid', 'checker-adapter'],
    ['checker-final-message-invalid', 'final-message'],
    ['checker-process-error', 'checker-adapter'],
    ['diagnostic-invalid', 'checker-adapter'],
  ];
  assert.deepEqual(CHECKER_PROCESS_REASON_CODES, validPairs.map(([reason]) => reason));
  for (const [reason_code, process_phase] of validPairs) {
    assert.equal(validCheckerProcessDiagnostic({ ...diagnostic, reason_code, process_phase }), true,
      `${reason_code}/${process_phase}`);
  }

  for (const [reason_code, process_phase] of [
    ['usage-receipt-write-failed', 'child-execution'],
    ['child-nonzero-exit', 'receipt-write'],
    ['worker-protocol-invalid', 'final-message'],
    ['checker-final-message-invalid', 'checker-adapter'],
  ]) {
    assert.equal(validCheckerProcessDiagnostic({ ...diagnostic, reason_code, process_phase }), false,
      `impossible pair ${reason_code}/${process_phase}`);
  }
});

test('checker identity diagnostic is optional, exact, closed, and mutually exclusive with process diagnostic', () => {
  const valid = {
    reason_code: 'capture-integrity-drift',
    identity_phase: 'post-process',
    identity_axis: 'capture-skill',
  };
  assert.equal(validCheckerIdentityDiagnostic(valid), true);
  const absent = minimalValid();
  absent.episodes.push({ id: '001-checker', status: 'blocked', request_rel: 'episodes/001-checker/request.md' });
  assert.equal(validate(absent).ok, true);
  const present = structuredClone(absent);
  present.episodes[0].checker_identity_diagnostic = valid;
  assert.equal(validate(present).ok, true);
  for (const [label, mutate] of [
    ['raw path', value => { value.path = '/tmp/secret'; }],
    ['open reason', value => { value.reason_code = 'attacker-reason'; }],
    ['open phase', value => { value.identity_phase = 'attacker-phase'; }],
    ['impossible pair', value => {
      value.reason_code = 'capture-publication-failed';
      value.identity_phase = 'post-process';
      value.identity_axis = 'capture-store';
    }],
    ['open axis', value => { value.identity_axis = 'attacker-axis'; }],
  ]) {
    const candidate = structuredClone(present);
    mutate(candidate.episodes[0].checker_identity_diagnostic);
    assert.equal(validate(candidate).ok, false, label);
  }
  const both = structuredClone(present);
  both.episodes[0].checker_process_diagnostic = {
    reason_code: 'child-nonzero-exit', process_phase: 'child-execution',
    stderr: { sha256: 'a'.repeat(64), byte_count: 0, truncated: false },
    stdout: { sha256: 'b'.repeat(64), byte_count: 0, truncated: false },
  };
  assert.equal(validate(both).ok, false, 'identity and process diagnostics are mutually exclusive');
});

test('checker import diagnostic is optional, exact, closed, and mutually exclusive with other diagnostics', () => {
  const stream = { sha256: 'a'.repeat(64), byte_count: 0, truncated: false };
  const valid = {
    reason_code: 'import-nonzero-exit', import_phase: 'child-execution',
    input: stream, stdout: stream, stderr: stream,
  };
  assert.equal(validCheckerImportDiagnostic(valid), true);
  const absent = minimalValid();
  absent.episodes.push({ id: '001-checker', status: 'blocked', request_rel: 'episodes/001-checker/request.md' });
  assert.equal(validate(absent).ok, true);
  const present = structuredClone(absent);
  present.episodes[0].checker_import_diagnostic = valid;
  assert.equal(validate(present).ok, true);
  for (const [label, mutate] of [
    ['missing input', value => { delete value.input; }],
    ['raw stderr', value => { value.stderr.raw = 'SECRET'; }],
    ['attacker path', value => { value.path = '/tmp/secret'; }],
    ['open reason', value => { value.reason_code = 'checker-import-exit-37'; }],
    ['open phase', value => { value.import_phase = 'attacker-phase'; }],
    ['impossible pair', value => { value.import_phase = 'output-parse'; }],
  ]) {
    const candidate = structuredClone(present);
    mutate(candidate.episodes[0].checker_import_diagnostic);
    assert.equal(validate(candidate).ok, false, label);
  }
  for (const field of ['checker_process_diagnostic', 'checker_identity_diagnostic']) {
    const mixed = structuredClone(present);
    mixed.episodes[0][field] = field === 'checker_process_diagnostic'
      ? { reason_code: 'child-nonzero-exit', process_phase: 'child-execution', stderr: stream, stdout: stream }
      : { reason_code: 'capture-integrity-drift', identity_phase: 'post-process', identity_axis: 'capture-skill' };
    assert.equal(validate(mixed).ok, false, `import and ${field} are mutually exclusive`);
  }
});

test('checker identity diagnostic accepts every initial-capture integrity axis and rejects phase drift', () => {
  for (const identity_axis of [
    'capture-directory', 'capture-record', 'capture-manifest', 'capture-skill',
  ]) {
    assert.equal(validCheckerIdentityDiagnostic({
      reason_code: 'capture-integrity-drift', identity_phase: 'capture', identity_axis,
    }), true, identity_axis);
  }
  assert.equal(validCheckerIdentityDiagnostic({
    reason_code: 'capture-publication-failed', identity_phase: 'post-process', identity_axis: 'capture-store',
  }), false);
});

test('activation deadline config accepts inclusive bounds and rejects out-of-range values', () => {
  for (const [value, expected] of [[59, false], [60, true], [86400, true], [86401, false]]) {
    const loop = minimalValid();
    loop.session_chain.activation_deadline_sec = value;
    const result = validate(loop);
    assert.equal(result.ok, expected, `${value}: ${result.errors.join('; ')}`);
  }
});

test('activation deadline config requires integer seconds', () => {
  for (const value of [60.5, '900', null]) {
    const loop = minimalValid();
    loop.session_chain.activation_deadline_sec = value;
    assert.equal(validate(loop).ok, false, String(value));
  }
});

test('lease rejects simultaneous stale TTL and activation deadline timers', () => {
  const loop = minimalValid();
  loop.session_chain.lease.expires_at = '2026-08-05T00:10:00.000Z';
  loop.session_chain.lease.activation_deadline_at = '2026-08-05T00:15:00.000Z';
  const result = validate(loop);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('must not both be non-null')));
});

test('legacy lease without activation fields and with null attempt receipt remains valid', () => {
  const loop = minimalValid();
  loop.session_chain.lease.acquisition_receipt = {
    takeover_kind: 'boundary-handoff', child_run_id: 'CHILD', superseded_owner_run_id: 'PARENT',
    boundary_event: { seq: 1, checksum: 'b'.repeat(64) }, project_root_digest: 'c'.repeat(64),
    project_binding_generation: 1, handoff_rel: 'handoffs/next.md', reservation_key: 'reservation',
    from_generation: 1, to_generation: 2, at: '2026-08-05T00:00:00.000Z', attempt_id: null,
  };
  assert.equal(Object.hasOwn(loop.session_chain.lease, 'activation_deadline_at'), false);
  assert.equal(Object.hasOwn(loop.session_chain.lease, 'activation'), false);
  assert.equal(Object.hasOwn(loop.session_chain.lease, 'expiry_receipt'), false);
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
});

test('activation receipt accepts the exact seven-key shape', () => {
  const loop = minimalValid();
  loop.session_chain.lease.activation = validActivationReceipt();
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
});

test('activation receipt rejects a missing required key', () => {
  for (const key of Object.keys(validActivationReceipt())) {
    const loop = minimalValid();
    loop.session_chain.lease.activation = validActivationReceipt();
    delete loop.session_chain.lease.activation[key];
    assert.equal(validate(loop).ok, false, key);
  }
});

test('activation receipt rejects an extra key', () => {
  const loop = minimalValid();
  loop.session_chain.lease.activation = { ...validActivationReceipt(), extra: true };
  assert.equal(validate(loop).ok, false);
});

test('activation receipt rejects wrong types and non-64-hex digests', () => {
  for (const mutate of [
    receipt => { receipt.generation = '2'; },
    receipt => { receipt.activation_token_digest = 'A'.repeat(64); },
  ]) {
    const loop = minimalValid();
    loop.session_chain.lease.activation = validActivationReceipt();
    mutate(loop.session_chain.lease.activation);
    assert.equal(validate(loop).ok, false);
  }
});

test('expiry receipt accepts the exact eleven-key shape', () => {
  const loop = minimalValid();
  loop.session_chain.lease.expiry_receipt = validExpiryReceipt();
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
});

test('expiry receipt rejects a missing required key', () => {
  const loop = minimalValid();
  loop.session_chain.lease.expiry_receipt = validExpiryReceipt();
  delete loop.session_chain.lease.expiry_receipt.subject_attempt_id;
  assert.equal(validate(loop).ok, false);
});

test('expiry receipt rejects an extra key', () => {
  const loop = minimalValid();
  loop.session_chain.lease.expiry_receipt = { ...validExpiryReceipt(), extra: true };
  assert.equal(validate(loop).ok, false);
});

test('expiry receipt rejects every closed-enum field outside its singleton domain', () => {
  for (const field of ['decision_kind', 'evidence_kind', 'authority', 'transition']) {
    const loop = minimalValid();
    loop.session_chain.lease.expiry_receipt = validExpiryReceipt();
    loop.session_chain.lease.expiry_receipt[field] = 'wrong-enum';
    assert.equal(validate(loop).ok, false, field);
  }
});

test('autonomy must be a non-null, non-array object', () => {
  const cases = [
    ['null', null], ['array', []], ['string', 'invalid'], ['number', 1], ['boolean', true],
  ];
  const accepted = [];
  const missingStableError = [];
  for (const [label, autonomy] of cases) {
    const loop = minimalValid();
    loop.autonomy = autonomy;
    const result = validate(loop);
    if (result.ok) accepted.push(label);
    if (!result.errors.includes('autonomy must be object')) missingStableError.push(label);
  }
  assert.deepEqual(accepted, []);
  assert.deepEqual(missingStableError, []);
});

test('runtime_source cannot exist without session_runtime', () => {
  const loop = minimalValid();
  loop.autonomy.runtime_source = 'skill-asserted';
  const result = validate(loop);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /runtime_source.*session_runtime/.test(e)));
});

test('new runtime state requires runtime_source skill-asserted', () => {
  const loop = minimalValid();
  loop.autonomy.session_runtime = 'claude';
  let result = validate(loop);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /runtime_source.*skill-asserted/.test(e)));

  loop.autonomy.runtime_source = 'inferred';
  result = validate(loop);
  assert.equal(result.ok, false);

  loop.autonomy.runtime_source = 'skill-asserted';
  assert.equal(validate(loop).ok, true);
});

test('missing required field fails', () => {
  const o = minimalValid(); delete o.goal;
  const r = validate(o);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('goal')));
});

test('bad enum fails', () => {
  const o = minimalValid(); o.status = 'bogus';
  const r = validate(o);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('status')));
});

test('invalid episode status fails', () => {
  const o = minimalValid(); o.episodes = [{ id: 'e', status: 'bogus' }];
  assert.equal(validate(o).ok, false);
});
test('invalid workstream status fails', () => {
  const o = minimalValid(); o.workstreams = [{ id: 'w', status: 'nope' }];
  assert.equal(validate(o).ok, false);
});

test('workstream terminal_events are policy-pinned and reject mixed authority', () => {
  for (const terminalEvents of [
    [{ seq: 12, checksum: 'a'.repeat(64) }],
    [{ seq: 12, checksum: 'a'.repeat(64) }, { seq: 13, checksum: 'b'.repeat(64) }],
  ]) {
    const loop = minimalValid();
    loop.workstreams = [{ id: 'w', status: 'ready', terminal_events: terminalEvents }];
    assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  }

  for (const terminalEvents of [
    ['12:ws-01:ready'],
    ['12:ws-01:ready', { seq: 13, checksum: 'b'.repeat(64) }],
  ]) {
    const loop = minimalValid();
    loop.workstreams = [{ id: 'w', status: 'ready', terminal_events: terminalEvents }];
    const result = validate(loop);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('workstream-session')));
  }

  for (const policy of ['compact-in-place', 'rotate-per-unit']) {
    const loop = minimalValid();
    loop.autonomy.continuation_policy = policy;
    loop.workstreams = [{ id: 'w', status: 'ready', terminal_events: ['12:ws-01:ready'] }];
    assert.equal(validate(loop).ok, true, `${policy}: ${validate(loop).errors.join('; ')}`);

    loop.workstreams[0].terminal_events = [{ seq: 12, checksum: 'a'.repeat(64) }];
    const structured = validate(loop);
    assert.equal(structured.ok, false);
    assert.ok(structured.errors.some(error => error.includes('legacy continuation policy')));

    loop.workstreams[0].terminal_events = [
      '12:ws-01:ready',
      { seq: 13, checksum: 'b'.repeat(64) },
    ];
    assert.equal(validate(loop).ok, false, `${policy} mixed authority`);
  }

  for (const terminalEvents of [
    'bad',
    [1],
    [{ seq: 0, checksum: 'a'.repeat(64) }],
    [{ seq: 1.5, checksum: 'a'.repeat(64) }],
    [{ seq: 1, checksum: 'A'.repeat(64) }],
    [{ seq: 1, checksum: 'a'.repeat(64), extra: true }],
    [{ seq: 1 }],
  ]) {
    const loop = minimalValid();
    loop.workstreams = [{ id: 'w', status: 'ready', terminal_events: terminalEvents }];
    const result = validate(loop);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes('workstreams[].terminal_events')));
  }
});
test('non-number budget.total fails', () => {
  const o = minimalValid(); o.budget = { unit: 'turns', total: 'lots' };
  assert.equal(validate(o).ok, false);
});
test('wrong schema_version fails', () => {
  const o = minimalValid(); o.schema_version = '9.9.9';
  assert.equal(validate(o).ok, false);
});

test('v0.4 schema requires root epoch, launch approval, takeover discriminator, and an exact scope per session', () => {
  const valid = minimalValid();
  valid.session_chain.sessions = [{ run_id: 'R', scope: { ...OPEN_WORKSTREAM_SCOPE } }];
  assert.equal(validate(valid).ok, true, validate(valid).errors.join('; '));

  for (const [label, mutate] of [
    ['binding generation', loop => { delete loop.project.binding_generation; }],
    ['attended approval', loop => { delete loop.autonomy.attended_launch_approval; }],
    ['takeover kind', loop => { delete loop.session_chain.lease.takeover_kind; }],
    ['scope', loop => { delete loop.session_chain.sessions[0].scope; }],
    ['scope extra field', loop => { loop.session_chain.sessions[0].scope.extra = true; }],
  ]) {
    const loop = structuredClone(valid);
    mutate(loop);
    assert.equal(validate(loop).ok, false, label);
  }
});

test('v0.4 schema validates the exact optional containing-session compact cursor', () => {
  const valid = minimalValid();
  valid.session_chain.lease.owner_run_id = 'R';
  valid.session_chain.lease.generation = 2;
  valid.session_chain.sessions = [{
    run_id: 'R',
    scope: { ...OPEN_WORKSTREAM_SCOPE },
    compact_cursor: {
      checkpoint_key: 'a'.repeat(64),
      context_sha256: 'b'.repeat(64),
      pre_restore_loop_hash: 'c'.repeat(64),
      owner_run_id: 'R',
      generation: 1,
      runtime: 'claude',
      workstream_id: 'ws-1',
      episode_id: '001-maker',
      baseline_turns: 53,
      restored_at: '2026-07-23T00:00:00.000Z',
      cycle: 2,
      restore_event: { seq: 42, checksum: 'd'.repeat(64) },
      admission: {
        kind: 'postcompact-observation', source: 'sessionstart', receipt_trigger: 'auto',
      },
      provider_evidence: { recorded: true, supplied: false, matched: false },
    },
  }];
  assert.equal(validate(valid).ok, true, validate(valid).errors.join('; '));

  const mutations = [
    ['extra key', loop => { loop.session_chain.sessions[0].compact_cursor.extra = true; }],
    ['wrong owner', loop => { loop.session_chain.sessions[0].compact_cursor.owner_run_id = 'OTHER'; }],
    ['uppercase checkpoint hash', loop => { loop.session_chain.sessions[0].compact_cursor.checkpoint_key = 'A'.repeat(64); }],
    ['unsafe baseline', loop => { loop.session_chain.sessions[0].compact_cursor.baseline_turns = -1; }],
    ['zero cycle', loop => { loop.session_chain.sessions[0].compact_cursor.cycle = 0; }],
    ['partial admission', loop => { delete loop.session_chain.sessions[0].compact_cursor.admission.source; }],
    ['invalid evidence combination', loop => {
      loop.session_chain.sessions[0].compact_cursor.provider_evidence = {
        recorded: false, supplied: false, matched: true,
      };
    }],
  ];
  for (const [label, mutate] of mutations) {
    const loop = structuredClone(valid);
    mutate(loop);
    assert.equal(validate(loop).ok, false, label);
  }
});

test('v0.4 schema pins exact Workstream/legacy scopes and recovery-owned optional fields', () => {
  const checksum = 'a'.repeat(64);
  const valid = minimalValid();
  valid.session_chain.sessions = [
    {
      run_id: 'R', recovered_from: 'OLD', recovery_kind: 'affinity-supersession',
      recovery_rel: 'recoveries/r.json', recovery_sha256: 'b'.repeat(64),
      recovery_project_binding_generation: 2,
      recovery_project_root_digest: 'c'.repeat(64),
      scope: {
        kind: 'workstream', workstream_id: 'ws-1', bound_at_seq: 7,
        terminal_event: { seq: 8, checksum }, closed_at: '2026-07-23T00:00:00.000Z',
        superseded_at: null, supersede_reason: 'host-session-lost', superseded_by: 'NEXT',
      },
    },
    {
      run_id: 'OLD', ended_at: '2026-07-22T00:00:00.000Z',
      scope: { kind: 'legacy', workstream_id: null, bound_at_seq: null, terminal_event: null, closed_at: '2026-07-22T00:00:00.000Z' },
    },
  ];
  assert.equal(validate(valid).ok, true, validate(valid).errors.join('; '));

  const mutations = [
    ['non-positive seq', loop => { loop.session_chain.sessions[0].scope.terminal_event.seq = 0; }],
    ['fractional seq', loop => { loop.session_chain.sessions[0].scope.terminal_event.seq = 1.5; }],
    ['uppercase checksum', loop => { loop.session_chain.sessions[0].scope.terminal_event.checksum = 'A'.repeat(64); }],
    ['rolled timestamp', loop => { loop.session_chain.sessions[0].scope.closed_at = '2026-02-31T00:00:00.000Z'; }],
    ['legacy workstream', loop => { loop.session_chain.sessions[1].scope.workstream_id = 'ws-1'; }],
    ['unsafe recovery rel', loop => { loop.session_chain.sessions[0].recovery_rel = '../escape.json'; }],
    ['bad recovery hash', loop => { loop.session_chain.sessions[0].recovery_sha256 = 'B'.repeat(64); }],
    ['partial recovery tuple', loop => { delete loop.session_chain.sessions[0].recovery_sha256; }],
    ['partial recovery root binding', loop => { delete loop.session_chain.sessions[0].recovery_project_root_digest; }],
    ['bad recovery root epoch', loop => { loop.session_chain.sessions[0].recovery_project_binding_generation = 0; }],
    ['bad recovery root digest', loop => { loop.session_chain.sessions[0].recovery_project_root_digest = 'C'.repeat(64); }],
    ['legacy supersession field', loop => { loop.session_chain.sessions[1].scope.superseded_by = 'NEXT'; }],
  ];
  for (const [label, mutate] of mutations) {
    const loop = structuredClone(valid);
    mutate(loop);
    assert.equal(validate(loop).ok, false, label);
  }
});

test('every affinity or boundary recovery tuple requires both root-binding fields', () => {
  const acceptedWithoutBinding = [];
  for (const recoveryKind of ['affinity-supersession', 'boundary-recovery']) {
    const loop = minimalValid();
    loop.session_chain.sessions = [{
      run_id: `RECOVERY-${recoveryKind}`,
      recovered_from: 'PARENT',
      recovery_kind: recoveryKind,
      recovery_rel: `recoveries/${recoveryKind}.json`,
      recovery_sha256: 'b'.repeat(64),
      scope: { ...OPEN_WORKSTREAM_SCOPE },
    }];
    const result = validate(loop);
    if (result.ok) acceptedWithoutBinding.push(recoveryKind);
    if (!result.ok) {
      assert.ok(result.errors.some(error => error.includes('recovery project binding')));
    }
  }
  assert.deepEqual(acceptedWithoutBinding, []);

  const orphanBinding = minimalValid();
  orphanBinding.session_chain.sessions = [{
    run_id: 'ORPHAN-BINDING',
    recovery_project_binding_generation: 1,
    recovery_project_root_digest: 'c'.repeat(64),
    scope: { ...OPEN_WORKSTREAM_SCOPE },
  }];
  const orphanResult = validate(orphanBinding);
  assert.equal(orphanResult.ok, false);
  assert.ok(orphanResult.errors.some(error => (
    error.includes('recovery project binding requires recovery fields')
  )));
});

test('v0.4 schema accepts all three policy labels but no longer rejects legacy Codex compact-in-place', () => {
  for (const policy of ['workstream-session', 'compact-in-place', 'rotate-per-unit']) {
    const loop = minimalValid();
    loop.autonomy.session_runtime = 'codex';
    loop.autonomy.runtime_source = 'skill-asserted';
    loop.autonomy.continuation_policy = policy;
    assert.equal(validate(loop).ok, true, `${policy}: ${validate(loop).errors.join('; ')}`);
  }
});

test('v0.4 schema validates relative locators and root-relocation review-claim history', () => {
  const loop = minimalValid();
  const frozenClaim = {
    run_id: 'R',
    reviewer_id: 'deep-review',
    checker_episode_id: '002-checker',
    target_maker: '001-maker',
    attempt_id: 'attempt-1',
    workstream_id: 'ws-1',
    point: 'implementation',
    project_root: '/old/root',
    runtime: 'codex',
    lease_owner: 'R',
    lease_generation: 1,
    artifacts: [{ path: '.claude/worktrees/ws/artifact.txt', sha256: 'a'.repeat(64) }],
    evidence: {
      insights_path: '.deep-loop/insights/01TEST-insights.json', emit_ulid: '01TEST',
      producer_run_id: 'R', sha256: 'b'.repeat(64), candidates: [],
    },
    contract: {
      slice: 'HILLCLIMB-001', path: '.claude/worktrees/ws/.deep-review/contracts/HILLCLIMB-001.yaml',
      sha256: 'c'.repeat(64),
    },
    invalidated_at: '2026-07-23T00:00:00.000Z',
    reason: 'project-root-relocated',
  };
  loop.episodes = [{
    id: '001-maker', status: 'pending', request_rel: 'episodes/001-maker/request.md',
    invalidated_review_claims: [frozenClaim],
  }];
  loop.session_chain.sessions = [{ run_id: 'R', handoff_rel: 'handoffs/next.md', scope: { ...OPEN_WORKSTREAM_SCOPE } }];
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));

  for (const [label, mutate] of [
    ['absolute request locator', x => { x.episodes[0].request_rel = '/tmp/request.md'; }],
    ['backslash request locator', x => { x.episodes[0].request_rel = String.raw`episodes\001-maker\request.md`; }],
    ['persisted request path', x => { x.episodes[0].request_path = '/tmp/request.md'; }],
    ['absolute handoff locator', x => { x.session_chain.sessions[0].handoff_rel = '/tmp/handoff.md'; }],
    ['persisted handoff path', x => { x.session_chain.sessions[0].handoff_path = '/tmp/handoff.md'; }],
    ['invalidated reason', x => { x.episodes[0].invalidated_review_claims[0].reason = 'other'; }],
    ['invalidated timestamp', x => { x.episodes[0].invalidated_review_claims[0].invalidated_at = 'today'; }],
  ]) {
    const candidate = structuredClone(loop);
    mutate(candidate);
    assert.equal(validate(candidate).ok, false, label);
  }

  const requiredClaimKeys = [
    'run_id', 'reviewer_id', 'checker_episode_id', 'target_maker', 'attempt_id',
    'workstream_id', 'point', 'project_root', 'runtime', 'lease_owner',
    'lease_generation', 'artifacts', 'invalidated_at', 'reason',
  ];
  const malformedClaims = requiredClaimKeys.map(key => [
    `missing ${key}`,
    claim => { delete claim[key]; },
  ]);
  malformedClaims.push(
    ['arbitrary frozen object', (_claim, episode) => { episode.invalidated_review_claims[0] = { run_id: 'R', invalidated_at: '2026-07-23T00:00:00.000Z', reason: 'project-root-relocated' }; }],
    ['extra claim field', claim => { claim.extra = true; }],
    ['unsupported reviewer', claim => { claim.reviewer_id = 'standalone'; }],
    ['unsafe attempt id', claim => { claim.attempt_id = '../attempt'; }],
    ['relative project root', claim => { claim.project_root = 'old/root'; }],
    ['invalid runtime', claim => { claim.runtime = 'other'; }],
    ['invalid lease generation', claim => { claim.lease_generation = 0; }],
    ['artifact extra field', claim => { claim.artifacts[0].extra = true; }],
    ['artifact unsafe path', claim => { claim.artifacts[0].path = '../artifact'; }],
    ['artifact invalid hash', claim => { claim.artifacts[0].sha256 = 'A'.repeat(64); }],
    ['duplicate artifact', claim => { claim.artifacts.push({ ...claim.artifacts[0] }); }],
    ['evidence missing producer', claim => { delete claim.evidence.producer_run_id; }],
    ['evidence extra field', claim => { claim.evidence.extra = true; }],
    ['evidence unsafe path', claim => { claim.evidence.insights_path = '../insights.json'; }],
    ['evidence invalid hash', claim => { claim.evidence.sha256 = 'bad'; }],
    ['evidence invalid candidates', claim => { claim.evidence.candidates = {}; }],
    ['contract missing slice', claim => { delete claim.contract.slice; }],
    ['contract extra field', claim => { claim.contract.extra = true; }],
    ['contract unsafe path', claim => { claim.contract.path = '../contract.yaml'; }],
    ['contract invalid hash', claim => { claim.contract.sha256 = 'bad'; }],
  );
  for (const [label, mutate] of malformedClaims) {
    const candidate = structuredClone(loop);
    const episode = candidate.episodes[0];
    mutate(episode.invalidated_review_claims[0], episode);
    assert.equal(validate(candidate).ok, false, label);
  }
});
test('non-number budget.soft_stop_ratio fails', () => {
  const o = minimalValid(); o.budget = { unit: 'turns', soft_stop_ratio: '0.8' };
  assert.equal(validate(o).ok, false);
});

test('budget.tokens_total accepts legacy zero and safe integer seeds but rejects unsafe state', () => {
  for (const value of [0, 4_000_000, 10_000_000, Number.MAX_SAFE_INTEGER]) {
    const loop = minimalValid();
    loop.budget.tokens_total = value;
    assert.equal(validate(loop).ok, true, String(value));
  }
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10000000']) {
    const loop = minimalValid();
    loop.budget.tokens_total = value;
    const result = validate(loop);
    assert.equal(result.ok, false, String(value));
    assert.ok(result.errors.some(error => error.includes('budget.tokens_total')), String(value));
  }
});

test('spawn_style enum accepts visible; session_spawn additive validates', () => {
  const loop = buildInitialLoop({ runtime: 'claude', runId: 'r1', goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z') });
  loop.autonomy.spawn_style = 'visible';
  loop.session_spawn = { platform: 'darwin', launcher: 'cmux', launcher_bin: '/x/cmux', launcher_socket: null, surface: 'workspace', reachable: true, visible: true, signals: {}, probe: { cmd: 'x ping', code: 0 }, reason: null, fallback: 'launch-command-file', detected_at: '2026-06-27T00:00:00Z' };
  assert.equal(validate(loop).ok, true, `validate errors: ${JSON.stringify(validate(loop).errors)}`);
  loop.autonomy.spawn_style = 'bogus';
  assert.equal(validate(loop).ok, false);
});

test('session_spawn null still validates (R5-plan)', () => {
  const loop = buildInitialLoop({ runtime: 'claude', runId: 'r1', goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z') });
  const loopNull = { ...loop, session_spawn: null };
  assert.equal(validate(loopNull).ok, true, `session_spawn:null must pass, errors: ${JSON.stringify(validate(loopNull).errors)}`);
});

test('session_spawn absent still validates', () => {
  const loop = buildInitialLoop({ runtime: 'claude', runId: 'r1', goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z') });
  const loopAbsent = { ...loop };
  delete loopAbsent.session_spawn;
  assert.equal(validate(loopAbsent).ok, true, `session_spawn absent must pass, errors: ${JSON.stringify(validate(loopAbsent).errors)}`);
});

test('episode status "abandoned" is a valid kernel terminal', () => {
  const base = minimalValid();
  base.episodes = [{ id: 'e1', role: 'maker', status: 'abandoned', point: 'implementation', workstream_id: 'w', request_rel: 'episodes/e1/request.md' }];
  const v = validate(base);
  assert.equal(v.ok, true, v.errors?.join('; '));
});

test('spawn_style=desktop is a valid enum value', () => {
  const loop = minimalValid();
  loop.autonomy.spawn_style = 'desktop';
  const res = validate(loop);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('autonomy.session_effort enum + session_model type (WS1, optional)', () => {
  const base = buildInitialLoop({ runtime: 'claude', goal: 'g', protocol: 'standalone', recipe: { id: 'r', name: 'r', reason: '' }, runId: 'SELFTEST00000000000000000T', now: new Date('2026-07-02T00:00:00Z') });
  // absent → ok (backward compat)
  assert.equal(validate(base).ok, true);
  // valid effort + model → ok
  base.autonomy.session_effort = 'xhigh';
  base.autonomy.session_model = 'claude-opus-4-8[1m]';
  assert.equal(validate(base).ok, true);
  // invalid effort → rejected
  base.autonomy.session_effort = 'ultra';
  assert.equal(validate(base).ok, false);
  base.autonomy.session_effort = 'xhigh';
  // non-string model → rejected
  base.autonomy.session_model = 123;
  const v = validate(base);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /session_model/.test(e)));
});

function validRuntimeApproval() {
  return {
    runtime: 'codex',
    canonical_path: '/opt/codex/vendor/aarch64-apple-darwin/bin/codex',
    sha256: 'a'.repeat(64),
    version: '0.144.1',
    platform: 'darwin',
    arch: 'arm64',
    source: 'official-npm-native',
    package: {
      wrapper_path: '/opt/codex/bin/codex.js',
      wrapper_name: '@openai/codex',
      wrapper_version: '0.144.1',
      optional_name: '@openai/codex-darwin-arm64',
      optional_spec: 'npm:@openai/codex@0.144.1-darwin-arm64',
      native_name: '@openai/codex',
      native_version: '0.144.1-darwin-arm64',
      target_triple: 'aarch64-apple-darwin',
      os: ['darwin'],
      cpu: ['arm64'],
    },
    authenticode: null,
    approved_by: 'human',
    approved_at: '2026-07-11T08:00:00.000Z',
  };
}

function validLauncherApproval(kind = 'wt') {
  if (kind === 'tmux') {
    return {
      kind,
      canonical_path: '/opt/homebrew/bin/tmux',
      sha256: 'b'.repeat(64),
      version: 'tmux 3.4',
      platform: 'darwin',
      arch: 'arm64',
      source: 'human-explicit',
      authenticode: null,
      approved_by: 'human',
      approved_at: '2026-07-20T00:00:00.000Z',
    };
  }
  return {
    kind,
    canonical_path: kind === 'wt' ? 'C:\\Program Files\\WindowsApps\\wt.exe' : 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    sha256: 'b'.repeat(64),
    version: kind === 'wt' ? '1.22.10352.0' : '7.5.2',
    platform: 'win32',
    arch: 'x64',
    source: 'human-explicit',
    authenticode: { status: 'valid', signer: 'Observed Publisher', thumbprint: 'aabbcc11' },
    approved_by: 'human',
    approved_at: '2026-07-12T01:00:00.000Z',
  };
}

function validCheckerApproval(checker = 'codex') {
  return {
    checker,
    reviewer_adapter: checker === 'codex' ? 'codex-checker' : 'grok-checker',
    provider_id: checker === 'codex' ? 'openai-codex' : 'xai-grok',
    model_id: checker === 'codex' ? 'gpt-5.6-sol' : 'grok-4.6',
    canonical_path: checker === 'codex' ? '/opt/codex/bin/codex' : '/opt/grok/bin/grok',
    sha256: (checker === 'codex' ? 'c' : 'd').repeat(64),
    version: checker === 'codex' ? '0.144.1' : '1.0.4',
    platform: 'darwin',
    arch: 'arm64',
    source: 'human-explicit',
    authenticode: null,
    approved_by: 'human',
    approved_at: checker === 'codex' ? '2026-08-15T08:01:00.000Z' : '2026-08-15T08:02:00.000Z',
  };
}

test('new runs initialize a null immutable runtime executable approval and valid approval state passes', () => {
  const loop = buildInitialLoop({ runtime: 'codex', goal: 'g', protocol: 'standalone', recipe: {}, runId: 'r1', now: new Date('2026-07-11T00:00:00Z') });
  assert.equal(loop.autonomy.runtime_executable_approval, null);
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));

  loop.autonomy.runtime_executable_approval = validRuntimeApproval();
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  assert.equal(classifyPatch('autonomy.runtime_executable_approval', validRuntimeApproval()), 'forbid');
});

test('runtime executable approval schema rejects malformed identity, authority, and runtime drift', () => {
  const mutations = [
    ['not object', () => 'approved'],
    ['wrong runtime', approval => ({ ...approval, runtime: 'claude' })],
    ['bad hash', approval => ({ ...approval, sha256: 'A'.repeat(64) })],
    ['empty path', approval => ({ ...approval, canonical_path: '' })],
    ['wrong source', approval => ({ ...approval, source: 'path-first' })],
    ['not human', approval => ({ ...approval, approved_by: 'agent' })],
    ['bad timestamp', approval => ({ ...approval, approved_at: 'today' })],
    ['bad package', approval => ({ ...approval, package: { wrapper_name: '@openai/codex' } })],
    ['authenticode primitive', approval => ({ ...approval, authenticode: 'signed' })],
  ];
  for (const [label, mutate] of mutations) {
    const loop = buildInitialLoop({ runtime: 'codex', goal: 'g', protocol: 'standalone', recipe: {}, runId: 'r1', now: new Date('2026-07-11T00:00:00Z') });
    loop.autonomy.runtime_executable_approval = mutate(validRuntimeApproval());
    const result = validate(loop);
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some(error => /runtime_executable_approval/.test(error)), `${label}: ${result.errors.join('; ')}`);
  }
});

test('checker executable approval map is exact, route-bound, distinct, legacy-readable, and immutable', () => {
  const loop = buildInitialLoop({ runtime: 'claude', goal: 'g', protocol: 'standalone', recipe: {}, runId: 'r1', now: new Date('2026-08-15T08:00:00Z') });
  assert.deepEqual(loop.autonomy.checker_executable_approvals, { codex: null, grok: null });
  loop.autonomy.checker_executable_approvals = {
    codex: validCheckerApproval('codex'),
    grok: validCheckerApproval('grok'),
  };
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  assert.equal(classifyPatch('autonomy.checker_executable_approvals', loop.autonomy.checker_executable_approvals), 'forbid');
  assert.equal(classifyPatch('autonomy.checker_executable_approvals.grok', validCheckerApproval('grok')), 'forbid');

  delete loop.autonomy.checker_executable_approvals;
  assert.equal(validate(loop).ok, true, 'legacy state without checker approvals must stay readable');
});

test('checker executable approval schema rejects malformed routes, fields, and cross-provider collisions', () => {
  const exact = () => ({
    codex: validCheckerApproval('codex'),
    grok: validCheckerApproval('grok'),
  });
  const mutations = [
    ['map null', () => null],
    ['missing slot', map => ({ codex: map.codex })],
    ['unknown slot', map => ({ ...map, claude: null })],
    ['primitive slot', map => ({ ...map, grok: 'approved' })],
    ['checker mismatch', map => ({ ...map, grok: { ...map.grok, checker: 'codex' } })],
    ['adapter mismatch', map => ({ ...map, grok: { ...map.grok, reviewer_adapter: 'codex-checker' } })],
    ['provider mismatch', map => ({ ...map, grok: { ...map.grok, provider_id: 'openai-codex' } })],
    ['model missing', map => {
      const grok = { ...map.grok };
      delete grok.model_id;
      return { ...map, grok };
    }],
    ['model mismatch', map => ({ ...map, grok: { ...map.grok, model_id: 'gpt-5.6-sol' } })],
    ['wrong basename', map => ({ ...map, grok: { ...map.grok, canonical_path: '/opt/grok/bin/not-grok' } })],
    ['script path', map => ({ ...map, grok: { ...map.grok, canonical_path: '/opt/grok/bin/grok.js' } })],
    ['uppercase hash', map => ({ ...map, grok: { ...map.grok, sha256: 'D'.repeat(64) } })],
    ['bad version', map => ({ ...map, grok: { ...map.grok, version: 'stable' } })],
    ['wrong source', map => ({ ...map, grok: { ...map.grok, source: 'path-search' } })],
    ['not human', map => ({ ...map, grok: { ...map.grok, approved_by: 'agent' } })],
    ['bad timestamp', map => ({ ...map, grok: { ...map.grok, approved_at: 'today' } })],
    ['unknown field', map => ({ ...map, grok: { ...map.grok, trusted: true } })],
    ['same canonical path', map => ({ ...map, grok: { ...map.grok, canonical_path: map.codex.canonical_path } })],
    ['same executable hash', map => ({ ...map, grok: { ...map.grok, sha256: map.codex.sha256 } })],
  ];
  for (const [label, mutate] of mutations) {
    const loop = buildInitialLoop({ runtime: 'claude', goal: 'g', protocol: 'standalone', recipe: {}, runId: 'r1', now: new Date('2026-08-15T08:00:00Z') });
    loop.autonomy.checker_executable_approvals = mutate(exact());
    const result = validate(loop);
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some(error => /checker_executable_approvals/.test(error)), `${label}: ${result.errors.join('; ')}`);
  }
});

test('launcher approval map is initialized, legacy-safe when absent, valid when exact, and never generic-patchable', () => {
  const loop = buildInitialLoop({ runtime: 'claude', goal: 'g', protocol: 'standalone', recipe: {}, runId: 'r1', now: new Date('2026-07-12T00:00:00Z') });
  assert.deepEqual(loop.autonomy.launcher_executable_approvals, { wt: null, powershell: null, tmux: null });
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));

  loop.autonomy.launcher_executable_approvals = {
    wt: validLauncherApproval('wt'), powershell: validLauncherApproval('powershell'), tmux: validLauncherApproval('tmux'),
  };
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  assert.equal(classifyPatch('autonomy.launcher_executable_approvals', loop.autonomy.launcher_executable_approvals), 'forbid');
  assert.equal(classifyPatch('autonomy.launcher_executable_approvals.wt', validLauncherApproval()), 'forbid');

  delete loop.autonomy.launcher_executable_approvals;
  assert.equal(validate(loop).ok, true, 'legacy state with no launcher approval map must remain valid');
});

test('tmux launcher approvals enforce POSIX platform, basename, null Authenticode, and exact fields', () => {
  const cases = [
    ['macOS', { canonical_path: '/opt/homebrew/bin/tmux', platform: 'darwin', arch: 'arm64' }],
    ['Linux', { canonical_path: '/usr/bin/tmux', platform: 'linux', arch: 'x64' }],
    ['WSL', { canonical_path: '/usr/local/bin/tmux', platform: 'linux', arch: 'x64' }],
  ];
  for (const [label, overrides] of cases) {
    const loop = minimalValid();
    loop.autonomy.launcher_executable_approvals = {
      wt: null,
      powershell: null,
      tmux: { ...validLauncherApproval('tmux'), ...overrides },
    };
    const result = validate(loop);
    assert.equal(result.ok, true, `${label}: ${result.errors.join('; ')}`);
  }

  for (const [label, mutate] of [
    ['unknown field', approval => ({ ...approval, trusted: true })],
    ['win32', approval => ({ ...approval, platform: 'win32' })],
    ['wrong basename', approval => ({ ...approval, canonical_path: '/usr/bin/not-tmux' })],
    ['case-sensitive basename', approval => ({ ...approval, canonical_path: '/usr/bin/TMUX' })],
    ['non-null Authenticode', approval => ({
      ...approval,
      authenticode: { status: 'valid', signer: 'Unexpected', thumbprint: 'aabb' },
    })],
  ]) {
    const loop = minimalValid();
    loop.autonomy.launcher_executable_approvals = {
      wt: null,
      powershell: null,
      tmux: mutate(validLauncherApproval('tmux')),
    };
    const result = validate(loop);
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some(error => /launcher_executable_approvals/.test(error)), `${label}: ${result.errors.join('; ')}`);
  }
});

test('session_spawn launcher enum accepts tmux', () => {
  const loop = minimalValid();
  loop.session_spawn = { launcher: 'tmux' };
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
});

test('launcher approval schema rejects malformed maps, identities, Authenticode, audit fields, and unknown keys', () => {
  const mutations = [
    ['map null', () => null],
    ['map array', () => []],
    ['unknown map key', map => ({ ...map, terminal: null })],
    ['primitive slot', map => ({ ...map, wt: 'approved' })],
    ['kind mismatch', map => ({ ...map, wt: { ...map.wt, kind: 'powershell' } })],
    ['bad kind', map => ({ ...map, wt: { ...map.wt, kind: 'cmd' } })],
    ['relative path', map => ({ ...map, wt: { ...map.wt, canonical_path: 'wt.exe' } })],
    ['UNC path', map => ({ ...map, wt: { ...map.wt, canonical_path: String.raw`\\server\share\wt.exe` } })],
    ['script path', map => ({ ...map, wt: { ...map.wt, canonical_path: 'C:\\tools\\wt.ps1' } })],
    ['uppercase hash', map => ({ ...map, wt: { ...map.wt, sha256: 'B'.repeat(64) } })],
    ['empty version', map => ({ ...map, wt: { ...map.wt, version: '' } })],
    ['wrong platform', map => ({ ...map, wt: { ...map.wt, platform: 'linux' } })],
    ['empty arch', map => ({ ...map, wt: { ...map.wt, arch: '' } })],
    ['wrong source', map => ({ ...map, wt: { ...map.wt, source: 'verified-native' } })],
    ['auth primitive', map => ({ ...map, wt: { ...map.wt, authenticode: 'signed' } })],
    ['auth status', map => ({ ...map, wt: { ...map.wt, authenticode: { ...map.wt.authenticode, status: 'invalid' } } })],
    ['auth signer', map => ({ ...map, wt: { ...map.wt, authenticode: { ...map.wt.authenticode, signer: '' } } })],
    ['auth thumbprint', map => ({ ...map, wt: { ...map.wt, authenticode: { ...map.wt.authenticode, thumbprint: 'AA BB' } } })],
    ['auth unknown key', map => ({ ...map, wt: { ...map.wt, authenticode: { ...map.wt.authenticode, trusted: true } } })],
    ['not human', map => ({ ...map, wt: { ...map.wt, approved_by: 'agent' } })],
    ['bad timestamp', map => ({ ...map, wt: { ...map.wt, approved_at: 'today' } })],
    ['unknown approval field', map => ({ ...map, wt: { ...map.wt, trusted: true } })],
  ];
  for (const [label, mutate] of mutations) {
    const loop = buildInitialLoop({ runtime: 'claude', goal: 'g', protocol: 'standalone', recipe: {}, runId: 'r1', now: new Date('2026-07-12T00:00:00Z') });
    const map = { wt: validLauncherApproval('wt'), powershell: null };
    loop.autonomy.launcher_executable_approvals = mutate(map);
    const result = validate(loop);
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some(error => /launcher_executable_approvals/.test(error)), `${label}: ${result.errors.join('; ')}`);
  }
});
