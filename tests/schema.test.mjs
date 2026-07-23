import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../scripts/lib/schema.mjs';
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

const OPEN_WORKSTREAM_SCOPE = Object.freeze({
  kind: 'workstream', workstream_id: null, bound_at_seq: null, terminal_event: null,
  closed_at: null, superseded_at: null,
});

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

test('workstream terminal_events accepts legacy strings plus exact structured event identities', () => {
  for (const terminalEvents of [
    ['12:ws-01:ready'],
    [{ seq: 12, checksum: 'a'.repeat(64) }],
    ['12:ws-01:ready', { seq: 13, checksum: 'b'.repeat(64) }],
  ]) {
    const loop = minimalValid();
    loop.workstreams = [{ id: 'w', status: 'ready', terminal_events: terminalEvents }];
    assert.equal(validate(loop).ok, true, validate(loop).errors.join('; '));
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

test('v0.4 schema pins exact Workstream/legacy scopes and recovery-owned optional fields', () => {
  const checksum = 'a'.repeat(64);
  const valid = minimalValid();
  valid.session_chain.sessions = [
    {
      run_id: 'R', recovered_from: 'OLD', recovery_kind: 'affinity-supersession',
      recovery_rel: 'recoveries/r.json', recovery_sha256: 'b'.repeat(64),
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
    ['legacy supersession field', loop => { loop.session_chain.sessions[1].scope.superseded_by = 'NEXT'; }],
  ];
  for (const [label, mutate] of mutations) {
    const loop = structuredClone(valid);
    mutate(loop);
    assert.equal(validate(loop).ok, false, label);
  }
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
