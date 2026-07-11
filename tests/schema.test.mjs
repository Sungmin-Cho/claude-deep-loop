import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../scripts/lib/schema.mjs';
import { buildInitialLoop } from '../scripts/lib/initrun.mjs';
import { classifyPatch } from '../scripts/lib/state.mjs';

function minimalValid() {
  return {
    schema_version: '0.2.0', run_id: 'R', goal: 'g', status: 'running',
    project: {}, routing: { protocol: 'deep-work' }, review: {}, autonomy: { tier: 'recommend', spawn_style: 'interactive' },
    budget: { unit: 'turns' }, comprehension: {}, circuit_breaker: {},
    session_chain: { lease: { state: 'active', handoff_phase: 'idle' }, sessions: [] },
    workstreams: [], active_workstreams: [], triage: {}, episodes: [], termination: {},
  };
}

test('valid loop.json passes', () => {
  assert.equal(validate(minimalValid()).ok, true);
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
test('non-number budget.total fails', () => {
  const o = minimalValid(); o.budget = { unit: 'turns', total: 'lots' };
  assert.equal(validate(o).ok, false);
});
test('wrong schema_version fails', () => {
  const o = minimalValid(); o.schema_version = '9.9.9';
  assert.equal(validate(o).ok, false);
});
test('non-number budget.soft_stop_ratio fails', () => {
  const o = minimalValid(); o.budget = { unit: 'turns', soft_stop_ratio: '0.8' };
  assert.equal(validate(o).ok, false);
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
  base.episodes = [{ id: 'e1', role: 'maker', status: 'abandoned', point: 'implementation', workstream_id: 'w' }];
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
