import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../scripts/lib/schema.mjs';
import { buildInitialLoop } from '../scripts/lib/initrun.mjs';
import { classifyPatch } from '../scripts/lib/state.mjs';
import { appHostTaskCwdDigest, hostSurfaceFactsDigest } from '../scripts/lib/host-surface.mjs';

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

function validLauncherApproval(kind = 'wt') {
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

test('launcher approval map is initialized, legacy-safe when absent, valid when exact, and never generic-patchable', () => {
  const loop = buildInitialLoop({ runtime: 'claude', goal: 'g', protocol: 'standalone', recipe: {}, runId: 'r1', now: new Date('2026-07-12T00:00:00Z') });
  assert.deepEqual(loop.autonomy.launcher_executable_approvals, { wt: null, powershell: null });
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));

  loop.autonomy.launcher_executable_approvals = {
    wt: validLauncherApproval('wt'), powershell: validLauncherApproval('powershell'),
  };
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  assert.equal(classifyPatch('autonomy.launcher_executable_approvals', loop.autonomy.launcher_executable_approvals), 'forbid');
  assert.equal(classifyPatch('autonomy.launcher_executable_approvals.wt', validLauncherApproval()), 'forbid');

  delete loop.autonomy.launcher_executable_approvals;
  assert.equal(validate(loop).ok, true, 'legacy state with no launcher approval map must remain valid');
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

function exactSchemaProjection({ runtime = 'codex', goal = 'g', consent = null,
  hostObservationDigest = 'NONE', enumProfile = null } = {}) {
  return {
    runtime, goal,
    routing: { protocol: 'standalone', recipe: { id: 'r', name: 'r', reason: 'test' } },
    review: null, model: null, effort: null,
    project: { root: '/repo', git: { git: false, head: null, branch: null, dirty: false } },
    plugins_detected: {}, session_spawn: {}, consent,
    host_observation_digest: hostObservationDigest, enum_profile: enumProfile,
  };
}

function appSchemaLoop({ auto = false } = {}) {
  const hostObservation = auto ? {
    kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
    structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: '/repo',
    host_task_cwd_source: 'app-task-context', kernel_cwd_at_observation: '/repo',
    observed_generation: 1, observed_at: '2026-07-13T00:00:00.000Z',
  } : null;
  return buildInitialLoop({ runtime: 'codex', goal: 'g', protocol: 'standalone',
    recipe: { id: 'r', name: 'r', reason: 'test' }, runId: '01JAPPGEN00000000000000000',
    now: new Date('2026-07-13T00:00:00.000Z'), initialization: {
      attempt_id: '01JAPPGEN00000000000000000', request_digest: 'a'.repeat(64),
      request_projection: exactSchemaProjection({
        consent: auto ? { mode: 'auto', authority: 'human-confirmed' } : null,
        hostObservationDigest: auto ? 'b'.repeat(64) : 'NONE',
      }),
      previous_current_digest: 'NONE', host_observation_digest: auto ? 'b'.repeat(64) : 'NONE',
      host_surface_digest: hostSurfaceFactsDigest(hostObservation),
    }, hostObservation, appContinuationRoute: auto ? 'create' : null,
    appContinuationConsent: auto ? {
      mode: 'auto', authority: 'human-confirmed',
      confirmed_at: '2026-07-13T00:00:00.000Z', revoked_at: null,
    } : null });
}

function emittedChild(parentObservation, targetCwd = '/repo') {
  return { run_id: '01JAPPCHD00000000000000000', started_at: null, ended_at: null,
    turns: 0, outcome: null, superseded_by: null, host_surface: null, continuation: {
      transport: 'codex-app', attempt_id: '01JAPPTASK0000000000000000', route: 'create',
      context_mode: 'fresh', phase: 'emitted', expected_runtime: 'codex',
      expected_host_surface: 'codex-app', target_cwd: targetCwd,
      host_task_cwd_digest: appHostTaskCwdDigest(parentObservation, targetCwd),
      workstream_id: null, project_id: null,
      descriptor_digest: null, emitted_at: '2026-07-13T00:00:00.000Z',
      prepare_deadline: '2026-07-13T00:05:00.000Z', prepared_at: null,
      confirmation_deadline: null, confirmed_at: null, acquired_at: null,
      acquired_generation: null, thread_id: null, unconfirmed_thread_id: null,
      failure_code: null, failure_binding: null,
  } };
}

function enumProfileSchemaLoop({ runtime = 'codex', kind = 'codex-app',
  source = 'codex-app-tool-provenance', capabilities = [] } = {}) {
  const runId = '01JAPPENUM0000000000000000';
  const observation = kind === null ? null : {
    kind, source, capabilities: structuredClone(capabilities), structured_stdin_mode: null,
    host_task_cwd: null, host_task_cwd_source: null, kernel_cwd_at_observation: '/repo',
    observed_generation: 1, observed_at: '2026-07-13T00:00:00.000Z',
  };
  return buildInitialLoop({ runtime, goal: 'enum', protocol: 'standalone',
    recipe: { id: 'r', name: 'r', reason: 'test' }, runId,
    now: new Date('2026-07-13T00:00:00.000Z'), initialization: {
      attempt_id: runId, request_digest: 'a'.repeat(64), previous_current_digest: 'NONE',
      request_projection: exactSchemaProjection({ runtime, goal: 'enum', enumProfile:
        kind === null ? null : { kind, source, capabilities: structuredClone(capabilities) } }),
      host_observation_digest: 'NONE',
      host_surface_digest: hostSurfaceFactsDigest(observation),
    }, hostObservation: observation });
}

test('initialization projection bounds and exact keys are enforced', () => {
  const base = appSchemaLoop({ auto: true });
  assert.equal(validate(base).ok, true, validate(base).errors.join('; '));
  const required = [
    'runtime', 'goal', 'routing', 'review', 'model', 'effort', 'project',
    'plugins_detected', 'session_spawn', 'consent', 'host_observation_digest', 'enum_profile',
  ];
  const invalid = [];

  const unknownTop = structuredClone(base);
  unknownTop.initialization.request_projection.extra = true;
  invalid.push(['unknown top-level key', unknownTop]);
  for (const key of required) {
    const candidate = structuredClone(base);
    delete candidate.initialization.request_projection[key];
    invalid.push([`missing ${key}`, candidate]);
  }
  for (const [label, mutate] of [
    ['routing key', p => { p.routing.extra = true; }],
    ['project key', p => { p.project.extra = true; }],
    ['git key', p => { p.project.git.extra = true; }],
    ['consent key', p => { p.consent.extra = true; }],
    ['enum profile key', p => { p.enum_profile = {
      kind: 'codex-app', source: 'codex-app-tool-provenance', capabilities: [], extra: true,
    }; }],
  ]) {
    const candidate = structuredClone(base);
    mutate(candidate.initialization.request_projection);
    invalid.push([`unknown ${label}`, candidate]);
  }

  const depthProjection = depth => {
    const candidate = structuredClone(base);
    let nested = null;
    for (let index = 0; index < depth - 1; index += 1) nested = { value: nested };
    candidate.initialization.request_projection.plugins_detected = nested;
    return candidate;
  };
  assert.equal(validate(depthProjection(8)).ok, true, 'depth 8 is the exact boundary');
  invalid.push(['depth 9', depthProjection(9)]);

  const countNodes = value => {
    if (value === null || typeof value !== 'object') return 1;
    return 1 + (Array.isArray(value) ? value : Object.values(value))
      .reduce((total, child) => total + countNodes(child), 0);
  };
  const nodeProjection = target => {
    const candidate = structuredClone(base);
    const projection = candidate.initialization.request_projection;
    projection.plugins_detected = { left: [], right: [] };
    let remaining = target - countNodes(projection);
    projection.plugins_detected.left = Array(Math.min(128, remaining)).fill(null);
    remaining -= projection.plugins_detected.left.length;
    projection.plugins_detected.right = Array(remaining).fill(null);
    assert.equal(countNodes(projection), target);
    return candidate;
  };
  assert.equal(validate(nodeProjection(256)).ok, true, '256 nodes is the exact boundary');
  invalid.push(['257 nodes', nodeProjection(257)]);

  const entryProjection = count => {
    const candidate = structuredClone(base);
    candidate.initialization.request_projection.plugins_detected = Array(count).fill(null);
    return candidate;
  };
  assert.equal(validate(entryProjection(128)).ok, true, '128 entries is the exact boundary');
  invalid.push(['129 entries', entryProjection(129)]);

  const stringProjection = bytes => {
    const candidate = structuredClone(base);
    candidate.initialization.request_projection.plugins_detected = 'x'.repeat(bytes);
    return candidate;
  };
  assert.equal(validate(stringProjection(4096)).ok, true, '4096-byte string is exact boundary');
  invalid.push(['4097-byte string', stringProjection(4097)]);

  const canonicalBytes = projection => Buffer.byteLength(JSON.stringify(projection), 'utf8');
  const canonicalProjection = target => {
    const candidate = structuredClone(base);
    const projection = candidate.initialization.request_projection;
    projection.plugins_detected = { payload: [] };
    while (target - canonicalBytes(projection) > 4003) {
      projection.plugins_detected.payload.push('x'.repeat(4000));
    }
    const remaining = target - canonicalBytes(projection);
    if (remaining >= 3) {
      projection.plugins_detected.payload.push('x'.repeat(remaining - 3));
    } else if (remaining > 0) {
      projection.plugins_detected.payload[0] += 'x'.repeat(remaining);
    }
    assert.equal(canonicalBytes(projection), target);
    return candidate;
  };
  assert.equal(validate(canonicalProjection(65_536)).ok, true,
    '65536 canonical bytes is the exact boundary');
  invalid.push(['65537 canonical bytes', canonicalProjection(65_537)]);

  for (const forbidden of ['__proto__', 'prototype', 'constructor']) {
    const candidate = structuredClone(base);
    candidate.initialization.request_projection.plugins_detected =
      JSON.parse(`{"${forbidden}":true}`);
    invalid.push([`forbidden ${forbidden}`, candidate]);
  }
  const undefinedValue = structuredClone(base);
  undefinedValue.initialization.request_projection.plugins_detected.bad = undefined;
  invalid.push(['undefined', undefinedValue]);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const candidate = structuredClone(base);
    candidate.initialization.request_projection.plugins_detected.bad = value;
    invalid.push([`non-finite ${value}`, candidate]);
  }
  const duplicateCapability = structuredClone(base);
  duplicateCapability.initialization.request_projection.enum_profile = {
    kind: 'codex-app', source: 'codex-app-tool-provenance', capabilities: ['x', 'x'],
  };
  invalid.push(['duplicate enum capability', duplicateCapability]);
  for (const consent of [
    { mode: 'auto', authority: 'default-manual' },
    { mode: 'manual', authority: 'human-confirmed' },
    { mode: 'bogus', authority: 'human-confirmed' },
  ]) {
    const candidate = structuredClone(base);
    candidate.initialization.request_projection.consent = consent;
    invalid.push([`wrong consent ${JSON.stringify(consent)}`, candidate]);
  }
  for (const [field, value] of [
    ['git', 'false'], ['head', 1], ['branch', false], ['dirty', 0],
  ]) {
    const candidate = structuredClone(base);
    candidate.initialization.request_projection.project.git[field] = value;
    invalid.push([`wrong git scalar ${field}`, candidate]);
  }

  for (const [label, candidate] of invalid) {
    assert.equal(validate(candidate).ok, false, label);
  }
});

test('enum-only initialization profile is allowlisted and runtime correlated', () => {
  const valid = enumProfileSchemaLoop();
  assert.equal(validate(valid).ok, true, validate(valid).errors.join('; '));
  const nullProfile = enumProfileSchemaLoop({ kind: null, source: null });
  assert.equal(validate(nullProfile).ok, false,
    'initialized genesis must retain a non-null observed host surface');
  const mutations = [
    ['unknown kind', profile => { profile.kind = 'unknown-host'; }],
    ['unknown source', profile => { profile.source = 'unknown-source'; }],
    ['unknown capability', profile => { profile.capabilities = ['unknown-capability']; }],
    ['runtime mismatch', (profile, projection) => { projection.runtime = 'claude'; }],
    ['kind mismatch', profile => { profile.kind = 'claude-code'; }],
    ['source mismatch', profile => { profile.source = 'codex-cli-host'; }],
    ['unsorted capabilities', profile => { profile.capabilities =
      ['send-message-to-thread', 'create-thread-local']; }],
    ['duplicate capabilities', profile => { profile.capabilities =
      ['create-thread-local', 'create-thread-local']; }],
    ['structured input capability', profile => { profile.capabilities =
      ['structured-process-stdin']; }],
  ];
  for (const [label, mutate] of mutations) {
    const candidate = structuredClone(valid);
    const projection = candidate.initialization.request_projection;
    mutate(projection.enum_profile, projection);
    assert.equal(validate(candidate).ok, false, label);
  }
});

test('genesis surface digest and observation clocks are exact anchors', () => {
  const full = appSchemaLoop({ auto: true });
  assert.equal(validate(full).ok, true, validate(full).errors.join('; '));
  const missingDigest = structuredClone(full);
  missingDigest.initialization.host_surface_digest = 'NONE';
  assert.equal(validate(missingDigest).ok, false,
    'non-null genesis requires its recomputed surface digest');
  const observationClockDrift = structuredClone(full);
  observationClockDrift.session_chain.sessions[0].host_surface.observed_at =
    '2026-07-13T00:00:01.000Z';
  assert.equal(validate(observationClockDrift).ok, false,
    'genesis observation clock must equal loop and session creation clock');
  const sessionClockDrift = structuredClone(full);
  sessionClockDrift.session_chain.sessions[0].started_at = '2026-07-13T00:00:01.000Z';
  assert.equal(validate(sessionClockDrift).ok, false);
  const nullSurface = appSchemaLoop();
  nullSurface.initialization.host_surface_digest = 'b'.repeat(64);
  assert.equal(validate(nullSurface).ok, false,
    'null genesis requires the exact NONE digest');
});

test('genesis observation cannot evade generation-one clock authority', () => {
  const loop = enumProfileSchemaLoop();
  const genesis = loop.session_chain.sessions[0].host_surface;
  genesis.observed_generation = 2;
  genesis.observed_at = '2026-07-13T00:00:01.000Z';
  loop.session_chain.lease.generation = 2;
  loop.initialization.host_surface_digest = hostSurfaceFactsDigest(genesis);
  assert.equal(validate(loop).ok, false,
    'later lease generation cannot reclassify the initialized first observation');
});

test('projection arrays are dense plain arrays and count every slot', () => {
  const base = enumProfileSchemaLoop();
  const sparseAggregate = structuredClone(base);
  sparseAggregate.initialization.request_projection.plugins_detected =
    Array.from({ length: 90 }, () => new Array(128));
  assert.equal(validate(sparseAggregate).ok, false,
    'sparse slots count toward the aggregate node bound');

  const sparseProjectionCapability = structuredClone(base);
  sparseProjectionCapability.initialization.request_projection.enum_profile.capabilities =
    new Array(1);
  assert.equal(validate(sparseProjectionCapability).ok, false,
    'enum profile capabilities must be dense');

  const sparseStoredCapability = structuredClone(base);
  sparseStoredCapability.session_chain.sessions[0].host_surface.capabilities = new Array(1);
  sparseStoredCapability.initialization.host_surface_digest =
    hostSurfaceFactsDigest(sparseStoredCapability.session_chain.sessions[0].host_surface);
  assert.equal(validate(sparseStoredCapability).ok, false,
    'stored observation capabilities must be dense');

  for (const [label, array] of [
    ['custom prototype', new (class ProjectionArray extends Array {})()],
    ['extra key', Object.assign([], { authority: true })],
  ]) {
    const candidate = structuredClone(base);
    candidate.initialization.request_projection.plugins_detected = array;
    assert.equal(validate(candidate).ok, false, label);
  }
  const accessor = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get: () => 'forbidden' });
  accessor.length = 1;
  const accessorCandidate = structuredClone(base);
  accessorCandidate.initialization.request_projection.plugins_detected = accessor;
  assert.equal(validate(accessorCandidate).ok, false, 'array accessors are rejected');
  const symbol = [];
  symbol[Symbol('authority')] = true;
  const symbolCandidate = structuredClone(base);
  symbolCandidate.initialization.request_projection.plugins_detected = symbol;
  assert.equal(validate(symbolCandidate).ok, false, 'array symbol keys are rejected');
});

test('projection and stored capability proxies fail before executing traps', () => {
  const proxyArray = () => {
    let trapCount = 0;
    const value = new Proxy(Array.from({ length: 129 }, () => null), {
      get(backing, property, receiver) {
        trapCount += 1;
        return property === 'length' ? 0 : Reflect.get(backing, property, receiver);
      },
    });
    return { value, traps: () => trapCount };
  };

  const projection = enumProfileSchemaLoop();
  const projectionProxy = proxyArray();
  projection.initialization.request_projection.plugins_detected = projectionProxy.value;
  assert.equal(validate(projection).ok, false);
  assert.equal(projectionProxy.traps(), 0,
    'projection proxy must be rejected before traversal');

  const stored = enumProfileSchemaLoop();
  const storedProxy = proxyArray();
  stored.session_chain.sessions[0].host_surface.capabilities = storedProxy.value;
  assert.equal(validate(stored).ok, false);
  assert.equal(storedProxy.traps(), 0,
    'stored capability proxy must be rejected before traversal or digesting');
});

test('App extension validation is additive, exact-keyed, and consent correlation is fail closed', () => {
  const legacy = minimalValid();
  assert.equal(validate(legacy).ok, true);
  const loop = enumProfileSchemaLoop();
  assert.equal(validate(loop).ok, true);
  const invalidConsent = structuredClone(loop);
  invalidConsent.autonomy.app_task_continuation = {
    mode: 'auto', authority: 'default-manual', confirmed_at: null, revoked_at: null,
  };
  assert.equal(validate(invalidConsent).ok, false);
  const invalidInit = structuredClone(loop);
  invalidInit.initialization.attempt_id = 'different';
  assert.equal(validate(invalidInit).ok, false);
  const unknownInit = structuredClone(loop);
  unknownInit.initialization.raw_request = 'forbidden';
  assert.equal(validate(unknownInit).ok, false);
  const unknownConsent = structuredClone(loop);
  unknownConsent.autonomy.app_task_continuation.extra = true;
  assert.equal(validate(unknownConsent).ok, false);
  const missingConsent = structuredClone(loop);
  delete missingConsent.autonomy.app_task_continuation;
  assert.equal(validate(missingConsent).ok, false);
  const missingSurface = structuredClone(loop);
  delete missingSurface.session_chain.sessions[0].host_surface;
  assert.equal(validate(missingSurface).ok, false);

  const revoked = appSchemaLoop({ auto: true });
  revoked.autonomy.app_task_continuation = {
    mode: 'manual', authority: 'human-confirmed',
    confirmed_at: '2026-07-13T00:00:00.000Z', revoked_at: '2026-07-13T00:00:01.000Z',
  };
  assert.equal(validate(revoked).ok, true, validate(revoked).errors.join('; '));
  revoked.autonomy.app_task_continuation.revoked_at = '2026-07-12T23:59:59.000Z';
  assert.equal(validate(revoked).ok, false);

  const auto = appSchemaLoop({ auto: true });
  assert.equal(validate(auto).ok, true, validate(auto).errors.join('; '));
  auto.session_chain.sessions[0].host_surface.capabilities = ['structured-process-stdin'];
  assert.equal(validate(auto).ok, false, 'auto consent requires a complete create or fork set');

  for (const resumePolicy of ['visible', 'headless', 'human']) {
    const legacyPolicy = minimalValid();
    legacyPolicy.session_chain.lease.resume_policy = resumePolicy;
    assert.equal(validate(legacyPolicy).ok, true,
      `legacy resume_policy ${resumePolicy} remains valid`);
  }

  const manualProfiles = [
    ['claude', 'claude-code', 'claude-cli-entrypoint'],
    ['claude', 'claude-desktop', 'claude-desktop-local-agent'],
    ['codex', 'codex-cli', 'codex-cli-host'],
    ['codex', 'codex-app', 'codex-app-tool-provenance'],
  ];
  for (const [index, [runtime, kind, source]] of manualProfiles.entries()) {
    const runId = `01JAPPMANAAA${String(index).padStart(14, '0')}`;
    const manual = buildInitialLoop({ runtime, goal: 'manual', protocol: 'standalone',
      recipe: { id: 'r', name: 'r', reason: 'test' }, runId,
      now: new Date('2026-07-13T00:00:00.000Z'), initialization: {
        attempt_id: runId, request_digest: 'a'.repeat(64), previous_current_digest: 'NONE',
        request_projection: exactSchemaProjection({ runtime, goal: 'manual',
          enumProfile: { kind, source, capabilities: [] } }),
        host_observation_digest: 'NONE',
        host_surface_digest: hostSurfaceFactsDigest({ kind, source, capabilities: [],
          structured_stdin_mode: null, host_task_cwd: null, host_task_cwd_source: null,
          kernel_cwd_at_observation: '/repo' }),
      }, hostObservation: { kind, source, capabilities: [], structured_stdin_mode: null,
        host_task_cwd: null, host_task_cwd_source: null,
        kernel_cwd_at_observation: '/repo', observed_generation: 1,
        observed_at: '2026-07-13T00:00:00.000Z' } });
    assert.equal(validate(manual).ok, true, `${kind} enum-only manual profile`);
  }
  const nullSurface = appSchemaLoop();
  assert.equal(nullSurface.session_chain.sessions[0].host_surface, null);
  assert.equal(validate(nullSurface).ok, false,
    'initialized null surface is rejected while initialization-absent legacy remains additive');

  const arbitraryMode = appSchemaLoop({ auto: true });
  arbitraryMode.session_chain.sessions[0].host_surface.capabilities = [];
  arbitraryMode.session_chain.sessions[0].host_surface.structured_stdin_mode = 'arbitrary';
  arbitraryMode.autonomy.app_task_continuation = {
    mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null,
  };
  assert.equal(validate(arbitraryMode).ok, false, 'no structured capability requires exact null mode');

  const controlledPath = appSchemaLoop({ auto: true });
  controlledPath.session_chain.sessions[0].host_surface.host_task_cwd = '/repo\u0085escape';
  controlledPath.session_chain.sessions[0].host_surface.kernel_cwd_at_observation = '/repo\u0085escape';
  assert.equal(validate(controlledPath).ok, false, 'C0/C1 path bytes are rejected');

  const missingGeneration = appSchemaLoop({ auto: true });
  delete missingGeneration.session_chain.sessions[0].host_surface.observed_generation;
  assert.equal(validate(missingGeneration).ok, false,
    'stored observations require a kernel generation');
  const zeroGeneration = appSchemaLoop({ auto: true });
  zeroGeneration.session_chain.sessions[0].host_surface.observed_generation = 0;
  assert.equal(validate(zeroGeneration).ok, false, 'observation generation is positive');
  const futureGeneration = appSchemaLoop({ auto: true });
  futureGeneration.session_chain.sessions[0].host_surface.observed_generation = 2;
  assert.equal(validate(futureGeneration).ok, false, 'future observation generation is invalid');
  const historicalGeneration = appSchemaLoop({ auto: true });
  historicalGeneration.session_chain.lease.generation = 2;
  assert.equal(validate(historicalGeneration).ok, true,
    'an older observation remains valid history but is not current App authority');
});

test('recovered child binding is exact and remains durable historical provenance', () => {
  const loop = appSchemaLoop({ auto: true });
  loop.status = 'paused';
  loop.pause_reason = 'recovered:awaiting-resume';
  Object.assign(loop.session_chain.lease, { state: 'released', handoff_phase: 'idle',
    handoff_transport: null, handoff_attempt_id: null, handoff_child_run_id: null,
    handoff_idempotency_key: null, resume_policy: null, expires_at: null });
  loop.session_chain.sessions.push({ run_id: '01JAPPCHD00000000000000000', started_at: null,
    ended_at: null, turns: 0, outcome: 'abandoned_recover', superseded_by: null,
    handoff_rel: 'handoffs/recovered.md',
    recovery_binding: { owner_run_id: loop.run_id, generation: 1 } });
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  const missing = structuredClone(loop);
  delete missing.session_chain.sessions[1].recovery_binding;
  assert.equal(validate(missing).ok, false,
    'new-format abandoned_recover sessions require their causal binding');
  const legacyMissing = structuredClone(missing);
  delete legacyMissing.initialization;
  legacyMissing.autonomy.app_task_continuation = {
    mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null,
  };
  assert.equal(validate(legacyMissing).ok, true,
    'initialization-absent legacy recovery keeps field-absence compatibility');
  const extra = structuredClone(loop);
  extra.session_chain.sessions[1].recovery_binding.extra = true;
  assert.equal(validate(extra).ok, false);
  const wrongOutcome = structuredClone(loop);
  wrongOutcome.session_chain.sessions[1].outcome = 'failed_launch';
  assert.equal(validate(wrongOutcome).ok, false);
  const progressed = structuredClone(loop);
  const laterRunId = '01JAPPCHD00000000000000001';
  progressed.status = 'running';
  progressed.pause_reason = null;
  progressed.session_chain.sessions[1].started_at = '2026-07-13T00:00:02.000Z';
  progressed.session_chain.sessions[1].outcome = 'took_over';
  progressed.session_chain.sessions[1].superseded_by = laterRunId;
  progressed.session_chain.sessions.push({ run_id: laterRunId,
    started_at: '2026-07-13T00:00:03.000Z', ended_at: null, turns: 0,
    outcome: null, superseded_by: null, handoff_rel: 'handoffs/later.md' });
  Object.assign(progressed.session_chain.lease, { owner_run_id: laterRunId, generation: 3,
    acquired_at: '2026-07-13T00:00:03.000Z', state: 'active', handoff_phase: 'acquired' });
  assert.equal(validate(progressed).ok, true,
    'durable recovery provenance survives the recovered owner handing off again');
  const badGeneration = structuredClone(loop);
  badGeneration.session_chain.sessions[1].recovery_binding.generation = 0;
  assert.equal(validate(badGeneration).ok, false);
  const futureGeneration = structuredClone(loop);
  futureGeneration.session_chain.sessions[1].recovery_binding.generation = 2;
  assert.equal(validate(futureGeneration).ok, false);
  const unknownOwner = structuredClone(loop);
  unknownOwner.session_chain.sessions[1].recovery_binding.owner_run_id =
    '01JAPPF0R00000000000000000';
  assert.equal(validate(unknownOwner).ok, false);
  const selfOwner = structuredClone(loop);
  selfOwner.session_chain.sessions[1].recovery_binding.owner_run_id =
    selfOwner.session_chain.sessions[1].run_id;
  assert.equal(validate(selfOwner).ok, false,
    'a recovered child cannot mint its own parent recovery authority');
});

test('App continuation emitted, prepared, confirmed, and current acquired phases are exact', () => {
  const loop = appSchemaLoop({ auto: true });
  const child = emittedChild(loop.session_chain.sessions[0].host_surface);
  loop.project.root = '/repo';
  loop.session_chain.sessions.push(child);
  loop.session_chain.sessions[0].superseded_by = child.run_id;
  Object.assign(loop.session_chain.lease, { state: 'releasing', handoff_phase: 'emitted',
    handoff_transport: 'codex-app', handoff_attempt_id: child.continuation.attempt_id,
    handoff_child_run_id: child.run_id, resume_policy: 'app' });
  assert.equal(validate(loop).ok, true);
  const aliasParent = structuredClone(loop);
  aliasParent.session_chain.sessions.push({ run_id: '01JAPPHST00000000000000066',
    started_at: null, ended_at: null, turns: 0, outcome: null,
    superseded_by: child.run_id, handoff_rel: 'handoffs/alias.md' });
  assert.equal(validate(aliasParent).ok, false,
    'an App child has exactly one phase-appropriate incoming parent');
  const staleParentAttestation = structuredClone(loop);
  staleParentAttestation.session_chain.lease.generation = 2;
  assert.equal(validate(staleParentAttestation).ok, false,
    'a live App binding cannot outlive the parent surface generation that authorized it');
  for (const badParentLink of [null, '01JAPPWR0NG000000000000000']) {
    const invalidLink = structuredClone(loop);
    invalidLink.session_chain.sessions[0].superseded_by = badParentLink;
    assert.equal(validate(invalidLink).ok, false,
      'a final emitted live binding requires the exact parent superseded_by child');
  }
  for (const mutate of [
    candidate => { candidate.session_chain.sessions[1].started_at =
      '2026-07-13T00:00:01.000Z'; },
    candidate => { candidate.session_chain.sessions[1].ended_at =
      '2026-07-13T00:00:01.000Z'; },
    candidate => { candidate.session_chain.sessions[1].outcome = 'failed_launch'; },
    candidate => { candidate.session_chain.sessions[1].superseded_by =
      '01JAPPCHD00000000000000018'; },
    candidate => { candidate.session_chain.sessions[0].outcome = 'took_over'; },
  ]) {
    const prematureLifecycle = structuredClone(loop);
    mutate(prematureLifecycle);
    assert.equal(validate(prematureLifecycle).ok, false,
      'live App parent and child lifecycle cannot advance before acquire or settlement');
  }
  child.continuation.attempt_id = 'opaque-but-not-ulid';
  assert.equal(validate(loop).ok, false);
  child.continuation.attempt_id = '01JAPPTASK0000000000000000';
  loop.autonomy.app_task_continuation = {
    mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null,
  };
  assert.equal(validate(loop).ok, false, 'primary live attempt requires current auto consent');
  loop.autonomy.app_task_continuation = {
    mode: 'auto', authority: 'human-confirmed',
    confirmed_at: '2026-07-13T00:00:00.000Z', revoked_at: null,
  };
  loop.session_chain.lease.handoff_phase = 'spawned';
  assert.equal(validate(loop).ok, false, 'emitted requires releasing/emitted lease');
  loop.session_chain.lease.handoff_phase = 'emitted';
  child.continuation.prepare_deadline = '2026-07-13T00:05:00.001Z';
  assert.equal(validate(loop).ok, false);
  child.continuation.prepare_deadline = '2026-07-13T00:05:00.000Z';

  child.continuation.phase = 'prepared';
  child.continuation.project_id = ' opaque $`\\ id ';
  child.continuation.descriptor_digest = 'd'.repeat(64);
  child.continuation.prepared_at = '2026-07-13T00:00:10.000Z';
  child.continuation.confirmation_deadline = '2026-07-13T00:02:10.000Z';
  loop.session_chain.lease.handoff_phase = 'spawned';
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  child.continuation.project_id = null;
  assert.equal(validate(loop).ok, false, 'prepared create requires project_id');
  child.continuation.project_id = 'project';

  child.continuation.phase = 'confirmed';
  child.continuation.confirmed_at = '2026-07-13T00:00:15.000Z';
  child.continuation.thread_id = ' thread $`\\ id ';
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));

  child.continuation.phase = 'acquired';
  child.continuation.acquired_at = '2026-07-13T00:00:20.000Z';
  child.continuation.acquired_generation = 2;
  child.started_at = child.continuation.acquired_at;
  child.host_surface = { ...structuredClone(loop.session_chain.sessions[0].host_surface),
    observed_generation: 2, observed_at: child.continuation.acquired_at };
  loop.session_chain.sessions[0].outcome = 'took_over';
  Object.assign(loop.session_chain.lease, { owner_run_id: child.run_id, generation: 2,
    acquired_at: child.continuation.acquired_at, state: 'active', handoff_phase: 'acquired',
    handoff_transport: null, handoff_attempt_id: null, handoff_child_run_id: null,
    handoff_idempotency_key: null, expires_at: null, resume_policy: null });
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  for (const [field, value] of [
    ['handoff_transport', 'codex-app'],
    ['handoff_attempt_id', '01JAPPTASK0000000000000000'],
    ['handoff_child_run_id', '01JAPPCHD00000000000000099'],
    ['handoff_idempotency_key', 'stale-acquire-key'],
    ['resume_policy', 'app'],
    ['expires_at', '2026-07-13T00:05:00.000Z'],
  ]) {
    const staleAcquireBinding = structuredClone(loop);
    staleAcquireBinding.session_chain.lease[field] = value;
    assert.equal(validate(staleAcquireBinding).ok, false,
      `immediate acquired lease rejects stale ${field}`);
  }
  for (const mutate of [
    candidate => { candidate.status = 'paused';
      candidate.pause_reason = 'forged-acquired';
      candidate.session_chain.lease.resume_policy = null; },
    candidate => { candidate.session_chain.lease.owner_run_id = '01JAPPWR0NG000000000000000'; },
    candidate => { candidate.session_chain.lease.acquired_at = '2026-07-13T00:00:21.000Z'; },
    candidate => { candidate.session_chain.sessions[0].outcome = null; },
    candidate => { candidate.session_chain.sessions[1].host_surface.observed_generation = 1; },
    candidate => { candidate.session_chain.sessions[1].started_at = null; },
    candidate => { candidate.session_chain.sessions[1].outcome = 'failed_launch'; },
    candidate => { candidate.session_chain.sessions[1].ended_at =
      '2026-07-13T00:00:21.000Z'; },
    candidate => { candidate.session_chain.sessions[1].superseded_by =
      '01JAPPCHD00000000000000017'; },
  ]) {
    const invalidCurrent = structuredClone(loop);
    mutate(invalidCurrent);
    assert.equal(validate(invalidCurrent).ok, false,
      'same-generation acquired provenance stays bound to owner and acquisition clock');
  }
  const laterReservation = structuredClone(loop);
  Object.assign(laterReservation.session_chain.lease, { state: 'active', handoff_phase: 'reserved',
    handoff_idempotency_key: 'next-reservation',
    handoff_child_run_id: '01JAPPCHD00000000000000016' });
  assert.equal(validate(laterReservation).ok, true,
    'same-generation acquired provenance survives a later reservation');
  const releasedAcquired = structuredClone(loop);
  releasedAcquired.session_chain.lease.state = 'released';
  assert.equal(validate(releasedAcquired).ok, true,
    'ordinary release preserves the acquired phase as valid progression history');
  const pausedAcquired = structuredClone(loop);
  pausedAcquired.status = 'paused';
  pausedAcquired.pause_reason = 'manual-acquired-preserve';
  pausedAcquired.session_chain.lease.resume_policy = 'human';
  assert.equal(validate(pausedAcquired).ok, true,
    'generic preserve-pause is an exact active/acquired progression shape');
  const terminalAcquired = structuredClone(loop);
  terminalAcquired.status = 'completed';
  terminalAcquired.termination = { ...(terminalAcquired.termination ?? {}),
    finished_at: '2026-07-13T00:00:30.000Z', final_report: 'final.md' };
  assert.equal(validate(terminalAcquired).ok, true,
    'proof correlation is event-level while terminal active/acquired state remains schema-valid');
  const recovered = structuredClone(loop);
  Object.assign(recovered.session_chain.lease, { state: 'released', handoff_phase: 'idle' });
  assert.equal(validate(recovered).ok, true,
    'same-generation acquired provenance survives release/recover cleanup');
  child.continuation.acquired_generation = 1;
  loop.session_chain.lease.owner_run_id = '01JAPPNEW00000000000000000';
  loop.session_chain.lease.acquired_at = '2026-07-13T00:00:21.000Z';
  assert.equal(validate(loop).ok, true, 'older acquired provenance remains historical');
  const duplicate = structuredClone(child);
  duplicate.run_id = '01JAPPCHD00000000000000001';
  loop.session_chain.sessions.push(duplicate);
  assert.equal(validate(loop).ok, false, 'attempt IDs are unique across historical sessions');
  loop.session_chain.sessions.pop();
  child.continuation.acquired_generation = 3;
  assert.equal(validate(loop).ok, false);
});

test('historical acquired provenance retains its unique took-over parent', () => {
  const loop = appSchemaLoop({ auto: true });
  loop.project.root = '/repo';
  const child = emittedChild(loop.session_chain.sessions[0].host_surface);
  Object.assign(child.continuation, {
    phase: 'acquired', project_id: 'project', descriptor_digest: 'd'.repeat(64),
    prepared_at: '2026-07-13T00:00:10.000Z',
    confirmation_deadline: '2026-07-13T00:02:10.000Z',
    confirmed_at: '2026-07-13T00:00:15.000Z', thread_id: 'thread',
    acquired_at: '2026-07-13T00:00:20.000Z', acquired_generation: 2,
  });
  child.started_at = child.continuation.acquired_at;
  child.host_surface = { ...structuredClone(loop.session_chain.sessions[0].host_surface),
    observed_generation: 2, observed_at: child.continuation.acquired_at };
  loop.session_chain.sessions[0].superseded_by = child.run_id;
  loop.session_chain.sessions[0].outcome = 'took_over';
  loop.session_chain.sessions.push(child);
  const currentOwner = '01JAPPHST00000000000000088';
  loop.session_chain.sessions.push({ run_id: currentOwner,
    started_at: '2026-07-13T00:00:30.000Z', ended_at: null, turns: 0,
    outcome: null, superseded_by: null, handoff_rel: 'handoffs/current.md' });
  Object.assign(loop.session_chain.lease, { owner_run_id: currentOwner, generation: 3,
    acquired_at: '2026-07-13T00:00:30.000Z', state: 'active', handoff_phase: 'idle',
    handoff_transport: null, handoff_attempt_id: null, handoff_child_run_id: null,
    handoff_idempotency_key: null, resume_policy: null, expires_at: null });
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  loop.session_chain.sessions[0].outcome = null;
  assert.equal(validate(loop).ok, false,
    'generation advance cannot erase the acquired child parent outcome');
});

test('failed recovery provenance remains exact after child progression', () => {
  const loop = appSchemaLoop({ auto: true });
  loop.project.root = '/repo';
  const parentSurface = loop.session_chain.sessions[0].host_surface;
  Object.assign(parentSurface, { capabilities: ['fork-thread-same-directory',
    'send-message-to-thread', 'structured-process-stdin'],
    host_task_cwd: '/repo/.worktrees/ws', kernel_cwd_at_observation: '/repo/.worktrees/ws' });
  loop.initialization.host_surface_digest = hostSurfaceFactsDigest(parentSurface);
  loop.workstreams = [{ id: 'WS1', title: 'ws', status: 'in_progress',
    worktree: '.worktrees/ws', depends_on: [] }];
  loop.active_workstreams = ['WS1'];
  const child = emittedChild(parentSurface, '/repo/.worktrees/ws');
  Object.assign(child.continuation, { route: 'fork', context_mode: 'inherited-completed-history',
    workstream_id: 'WS1', phase: 'failed', failure_code: 'message-unconfirmed',
    failure_binding: { owner_run_id: loop.run_id, generation: 1 },
    unconfirmed_thread_id: 'opaque-thread', descriptor_digest: 'd'.repeat(64),
    prepared_at: '2026-07-13T00:00:10.000Z',
    confirmation_deadline: '2026-07-13T00:02:10.000Z' });
  child.outcome = 'took_over';
  child.recovery_binding = structuredClone(child.continuation.failure_binding);
  loop.session_chain.sessions.push(child);
  const currentOwner = '01JAPPHST00000000000000077';
  loop.session_chain.sessions.push({ run_id: currentOwner,
    started_at: '2026-07-13T00:00:30.000Z', ended_at: null, turns: 0,
    outcome: null, superseded_by: null, handoff_rel: 'handoffs/current.md' });
  Object.assign(loop.session_chain.lease, { owner_run_id: currentOwner, generation: 3,
    acquired_at: '2026-07-13T00:00:30.000Z', state: 'active', handoff_phase: 'idle',
    handoff_transport: null, handoff_attempt_id: null, handoff_child_run_id: null,
    handoff_idempotency_key: null, resume_policy: null, expires_at: null });
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  const missing = structuredClone(loop);
  delete missing.session_chain.sessions[1].recovery_binding;
  assert.equal(validate(missing).ok, false,
    'progressed failed child cannot drop its recovery binding');
  const rebound = structuredClone(loop);
  rebound.session_chain.sessions[1].recovery_binding = {
    owner_run_id: currentOwner, generation: 2,
  };
  assert.equal(validate(rebound).ok, false,
    'later generations cannot rebind failed recovery provenance');
});

test('live App parent route projection rejects impossible create and fork bindings', () => {
  const create = appSchemaLoop({ auto: true });
  create.project.root = '/repo';
  const createChild = emittedChild(create.session_chain.sessions[0].host_surface);
  create.session_chain.sessions.push(createChild);
  create.session_chain.sessions[0].superseded_by = createChild.run_id;
  Object.assign(create.session_chain.lease, { state: 'releasing', handoff_phase: 'emitted',
    handoff_transport: 'codex-app', handoff_attempt_id: createChild.continuation.attempt_id,
    handoff_child_run_id: createChild.run_id, resume_policy: 'app' });
  assert.equal(validate(create).ok, true, validate(create).errors.join('; '));
  for (const mutate of [
    candidate => { candidate.session_chain.sessions[0].host_surface.capabilities =
      ['structured-process-stdin']; },
    candidate => { candidate.session_chain.sessions[1].continuation.route = 'fork';
      candidate.session_chain.sessions[1].continuation.context_mode =
        'inherited-completed-history';
      candidate.session_chain.sessions[1].continuation.workstream_id = 'WS1'; },
    candidate => { candidate.session_chain.sessions[1].continuation.target_cwd = '/other';
      candidate.session_chain.sessions[1].continuation.host_task_cwd_digest =
        appHostTaskCwdDigest(candidate.session_chain.sessions[0].host_surface, '/other'); },
    candidate => { candidate.session_chain.sessions[1].continuation.host_task_cwd_digest =
      'f'.repeat(64); },
  ]) {
    const invalid = structuredClone(create);
    mutate(invalid);
    invalid.initialization.host_surface_digest =
      hostSurfaceFactsDigest(invalid.session_chain.sessions[0].host_surface);
    assert.equal(validate(invalid).ok, false, 'create binding drift is rejected');
  }

  const fork = appSchemaLoop({ auto: true });
  fork.project.root = '/repo';
  const parent = fork.session_chain.sessions[0].host_surface;
  Object.assign(parent, { capabilities: ['fork-thread-same-directory',
    'send-message-to-thread', 'structured-process-stdin'],
    host_task_cwd: '/repo/.worktrees/ws', kernel_cwd_at_observation: '/repo/.worktrees/ws' });
  fork.initialization.host_surface_digest = hostSurfaceFactsDigest(parent);
  fork.workstreams = [{ id: 'WS1', title: 'ws', status: 'in_progress',
    worktree: '.worktrees/ws', depends_on: [] }];
  fork.active_workstreams = ['WS1'];
  const forkChild = emittedChild(parent, '/repo/.worktrees/ws');
  Object.assign(forkChild.continuation, { route: 'fork',
    context_mode: 'inherited-completed-history', workstream_id: 'WS1' });
  fork.session_chain.sessions.push(forkChild);
  fork.session_chain.sessions[0].superseded_by = forkChild.run_id;
  Object.assign(fork.session_chain.lease, { state: 'releasing', handoff_phase: 'emitted',
    handoff_transport: 'codex-app', handoff_attempt_id: forkChild.continuation.attempt_id,
    handoff_child_run_id: forkChild.run_id, resume_policy: 'app' });
  assert.equal(validate(fork).ok, true, validate(fork).errors.join('; '));
  for (const mutate of [
    candidate => { candidate.active_workstreams = []; },
    candidate => { candidate.active_workstreams = ['WS1', 'WS1']; },
    candidate => { candidate.workstreams.push(structuredClone(candidate.workstreams[0])); },
    candidate => { candidate.workstreams[0].status = 'ready'; },
    candidate => { candidate.workstreams[0].worktree = '.worktrees/other'; },
    candidate => { candidate.workstreams[0].worktree = 'arbitrary/ws'; },
    candidate => { candidate.session_chain.sessions[1].continuation.workstream_id = 'WS2'; },
  ]) {
    const invalid = structuredClone(fork); mutate(invalid);
    assert.equal(validate(invalid).ok, false, 'fork workstream correlation is exact');
  }

  const windows = appSchemaLoop({ auto: true });
  windows.project.root = 'C:\\Repo';
  const windowsParent = windows.session_chain.sessions[0].host_surface;
  Object.assign(windowsParent, { capabilities: ['fork-thread-same-directory',
    'send-message-to-thread', 'structured-process-stdin'],
    host_task_cwd: 'C:/Repo/.worktrees/ws',
    kernel_cwd_at_observation: 'C:/Repo/.worktrees/ws' });
  windows.initialization.host_surface_digest = hostSurfaceFactsDigest(windowsParent);
  windows.workstreams = [{ id: 'WS1', title: 'ws', status: 'in_review',
    worktree: '.worktrees\\ws', depends_on: [] }];
  windows.active_workstreams = ['WS1'];
  const windowsChild = emittedChild(windowsParent, 'C:\\Repo\\.worktrees\\ws');
  Object.assign(windowsChild.continuation, { route: 'fork',
    context_mode: 'inherited-completed-history', workstream_id: 'WS1' });
  windows.session_chain.sessions.push(windowsChild);
  windows.session_chain.sessions[0].superseded_by = windowsChild.run_id;
  Object.assign(windows.session_chain.lease, { state: 'releasing', handoff_phase: 'emitted',
    handoff_transport: 'codex-app', handoff_attempt_id: windowsChild.continuation.attempt_id,
    handoff_child_run_id: windowsChild.run_id, resume_policy: 'app' });
  assert.equal(validate(windows).ok, true,
    'stored Windows path flavor accepts equivalent separators independent of test host');
  const caseDrift = structuredClone(windows);
  caseDrift.session_chain.sessions[1].continuation.target_cwd =
    'c:\\Repo\\.worktrees\\ws';
  caseDrift.session_chain.sessions[1].continuation.host_task_cwd_digest =
    appHostTaskCwdDigest(caseDrift.session_chain.sessions[0].host_surface,
      caseDrift.session_chain.sessions[1].continuation.target_cwd);
  assert.equal(validate(caseDrift).ok, false,
    'stored path casing is authority and case drift fails closed');
});

test('failed fork uncertainty is the only unconfirmed-thread shape and unknown continuation keys fail', () => {
  const loop = appSchemaLoop({ auto: true });
  loop.project.root = '/repo';
  const parentSurface = loop.session_chain.sessions[0].host_surface;
  Object.assign(parentSurface, { capabilities: ['fork-thread-same-directory',
    'send-message-to-thread', 'structured-process-stdin'],
    host_task_cwd: '/repo/.worktrees/ws', kernel_cwd_at_observation: '/repo/.worktrees/ws' });
  loop.initialization.host_surface_digest = hostSurfaceFactsDigest(parentSurface);
  loop.workstreams = [{ id: 'WS1', title: 'ws', status: 'in_progress',
    worktree: '.worktrees/ws', depends_on: [] }];
  loop.active_workstreams = ['WS1'];
  const child = emittedChild(parentSurface, '/repo/.worktrees/ws');
  Object.assign(child.continuation, { route: 'fork', context_mode: 'inherited-completed-history',
    workstream_id: 'WS1', phase: 'failed', failure_code: 'message-unconfirmed',
    failure_binding: { owner_run_id: loop.run_id, generation: 1 },
    unconfirmed_thread_id: 'opaque-thread', descriptor_digest: 'd'.repeat(64),
    prepared_at: '2026-07-13T00:00:10.000Z',
    confirmation_deadline: '2026-07-13T00:02:10.000Z' });
  loop.session_chain.sessions.push(child);
  loop.session_chain.sessions[0].superseded_by = child.run_id;
  Object.assign(loop.session_chain.lease, { state: 'releasing', handoff_phase: 'spawned',
    handoff_transport: 'codex-app', handoff_attempt_id: child.continuation.attempt_id,
    handoff_child_run_id: child.run_id, resume_policy: 'human', expires_at: null });
  loop.status = 'paused';
  loop.pause_reason = 'message-unconfirmed';
  assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
  for (const mutateBinding of [
    candidate => { candidate.session_chain.sessions[1].continuation.failure_binding = null; },
    candidate => { candidate.session_chain.sessions[1].continuation.failure_binding.extra = true; },
    candidate => { candidate.session_chain.sessions[1].continuation.failure_binding.owner_run_id = child.run_id; },
    candidate => { candidate.session_chain.sessions[1].continuation.failure_binding.owner_run_id = '01JAPPF0R00000000000000000'; },
    candidate => { candidate.session_chain.sessions[1].continuation.failure_binding.generation = 0; },
    candidate => { candidate.session_chain.sessions[1].continuation.failure_binding.generation = 2; },
  ]) {
    const rejected = structuredClone(loop);
    mutateBinding(rejected);
    assert.equal(validate(rejected).ok, false,
      'failed continuation binding is exact, parent-owned, positive, and non-future');
  }
  const otherOwner = structuredClone(loop);
  const otherRunId = '01JAPPHST00000000000000077';
  otherOwner.session_chain.sessions.push({ run_id: otherRunId,
    started_at: null, ended_at: null, turns: 0, outcome: 'failed_launch',
    superseded_by: null, handoff_rel: 'handoffs/other.md' });
  otherOwner.session_chain.sessions[1].continuation.failure_binding.owner_run_id = otherRunId;
  assert.equal(validate(otherOwner).ok, false,
    'a live failed binding must equal the current lease owner and generation');
  for (const invalid of [
    candidate => { candidate.session_chain.sessions[1].continuation.failure_code = 'launch-failed'; },
    candidate => { candidate.session_chain.sessions[1].continuation.failure_code = 'run-finished'; },
    candidate => { candidate.session_chain.sessions[1].continuation.unconfirmed_thread_id = 'bad\ud800id'; },
    candidate => { candidate.session_chain.sessions[1].continuation.unconfirmed_thread_id = 'bad\udc00id'; },
    candidate => {
      const continuation = candidate.session_chain.sessions[1].continuation;
      continuation.phase = 'abandoned';
      continuation.failure_code = 'host-call-failed';
      continuation.unconfirmed_thread_id = null;
    },
  ]) {
    const rejected = structuredClone(loop);
    invalid(rejected);
    assert.equal(validate(rejected).ok, false,
      'failure codes are closed and phase-partitioned; opaque IDs must round-trip through UTF-8');
  }
  const notPaused = structuredClone(loop);
  notPaused.status = 'running';
  notPaused.pause_reason = null;
  assert.equal(validate(notPaused).ok, false, 'human preserve requires paused state');
  const expiring = structuredClone(loop);
  expiring.session_chain.lease.expires_at = '2026-07-13T00:01:00.000Z';
  assert.equal(validate(expiring).ok, false, 'human preserve clears expiry');
  const genericPauseReason = structuredClone(loop);
  genericPauseReason.pause_reason = 'app-task-human-preserve';
  assert.equal(validate(genericPauseReason).ok, false,
    'failed message uncertainty uses its exact failure code, unlike revoke-abandoned');
  child.continuation.route = 'create';
  child.continuation.context_mode = 'fresh';
  child.continuation.workstream_id = null;
  assert.equal(validate(loop).ok, false);
  child.continuation.route = 'fork';
  child.continuation.context_mode = 'inherited-completed-history';
  child.continuation.workstream_id = 'WS1';
  child.continuation.raw_host_receipt = 'forbidden';
  assert.equal(validate(loop).ok, false);
});
