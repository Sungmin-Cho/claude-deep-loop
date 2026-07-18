import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { readFileSync } from 'node:fs';
import { reserveHandoff } from '../scripts/lib/lease.mjs';
import { EFFORT_LEVELS, validateEffort, validateModel, validateRuntimeProfile, setSessionProfile } from '../scripts/lib/session-profile.mjs';

function seed(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-sp-'));
  const { runId } = initRun(root, { runtime, goal: 'g', detected: {}, now: new Date('2026-07-02T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }) });
  return { root, runId };
}
const expect_ = (runId) => ({ owner: runId, generation: 1 });

test('validateEffort accepts allowlist, rejects others', () => {
  assert.deepEqual(EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const e of EFFORT_LEVELS) assert.equal(validateEffort(e), e);
  assert.throws(() => validateEffort('ultra'), /INVALID_EFFORT/);
  assert.throws(() => validateEffort(''), /INVALID_EFFORT/);
  assert.throws(() => validateEffort('XHIGH'), /INVALID_EFFORT/);
});

test('validateModel accepts real ids/aliases, rejects injection', () => {
  for (const m of ['claude-opus-4-8[1m]', 'claude-sonnet-5', 'opus', 'claude-haiku-4-5-20251001']) assert.equal(validateModel(m), m);
  for (const bad of ['-p', '--model', 'a b', 'a;b', "a'b", 'a`b', '', 'a'.repeat(129), '.leading']) assert.throws(() => validateModel(bad), /INVALID_MODEL/, `should reject ${JSON.stringify(bad)}`);
});

test('validateRuntimeProfile preserves runtime-specific model/effort and rejects Codex max', () => {
  assert.deepEqual(
    validateRuntimeProfile('claude', { model: 'claude-opus-4-8[1m]', effort: 'max' }),
    { model: 'claude-opus-4-8[1m]', effort: 'max' },
  );
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    assert.deepEqual(validateRuntimeProfile('codex', { model: 'gpt-5.4', effort }), { model: 'gpt-5.4', effort });
  }
  assert.throws(() => validateRuntimeProfile('codex', { model: 'gpt-5.4', effort: 'max' }), /UNSUPPORTED_RUNTIME_EFFORT/);
  assert.throws(() => validateRuntimeProfile('other', { model: 'gpt-5.4', effort: 'high' }), /INVALID_RUNTIME/);
});

test('setSessionProfile rejects Codex max before mutation', () => {
  const { root, runId } = seed('codex');
  const seq0 = readState(root, runId).data.event_log_head.seq;
  assert.throws(
    () => setSessionProfile(root, runId, { effort: 'max', expect: expect_(runId), now: 1 }),
    /UNSUPPORTED_RUNTIME_EFFORT/,
  );
  assert.equal(readState(root, runId).data.event_log_head.seq, seq0);
  assert.equal(readState(root, runId).data.autonomy.session_effort, undefined);
});

test('session profile on an initialized run persists both fields as sequence two', () => {
  const { root, runId } = seed();
  assert.equal(readState(root, runId).data.event_log_head.seq, 1,
    'successful production initialization is the first event');
  const r = setSessionProfile(root, runId, { model: 'claude-opus-4-8[1m]', effort: 'xhigh', expect: expect_(runId), now: 1 });
  assert.deepEqual(r, { ok: true, changed: true });
  const { data } = readState(root, runId);
  assert.equal(data.autonomy.session_model, 'claude-opus-4-8[1m]');
  assert.equal(data.autonomy.session_effort, 'xhigh');
  assert.equal(data.event_log_head.seq, 2); // initialization plus exactly one business event
});

test('setSessionProfile is idempotent no-op on identical values', () => {
  const { root, runId } = seed();
  setSessionProfile(root, runId, { model: 'opus', effort: 'high', expect: expect_(runId), now: 1 });
  const seqAfterFirst = readState(root, runId).data.event_log_head.seq;
  const r = setSessionProfile(root, runId, { model: 'opus', effort: 'high', expect: expect_(runId), now: 2 });
  assert.equal(r.changed, false);
  assert.equal(readState(root, runId).data.event_log_head.seq, seqAfterFirst); // no new event
});

test('setSessionProfile partial update does not wipe the other field', () => {
  const { root, runId } = seed();
  setSessionProfile(root, runId, { model: 'opus', effort: 'high', expect: expect_(runId), now: 1 });
  setSessionProfile(root, runId, { effort: 'low', expect: expect_(runId), now: 2 }); // model omitted
  const { data } = readState(root, runId);
  assert.equal(data.autonomy.session_model, 'opus'); // preserved
  assert.equal(data.autonomy.session_effort, 'low');
});

test('setSessionProfile rejects fence mismatch (even on no-op)', () => {
  const { root, runId } = seed();
  setSessionProfile(root, runId, { model: 'opus', expect: expect_(runId), now: 1 });
  assert.throws(() => setSessionProfile(root, runId, { model: 'opus', expect: { owner: runId, generation: 2 }, now: 2 }), /LEASE_FENCED/);
  assert.throws(() => setSessionProfile(root, runId, { model: 'sonnet', expect: { owner: 'WRONG', generation: 1 }, now: 2 }), /LEASE_FENCED/);
});

test('setSessionProfile succeeds during releasing lease (intent lease)', () => {
  const { root, runId } = seed();
  reserveHandoff(root, runId, { trigger: 'milestone', now: 1, expect: expect_(runId) });
  // emulate emitted/releasing lease
  const { data } = readState(root, runId);
  data.session_chain.lease = { ...data.session_chain.lease, state: 'releasing', handoff_phase: 'emitted' };
  writeState(root, runId, data);
  const r = setSessionProfile(root, runId, { effort: 'low', expect: expect_(runId), now: 2 });
  assert.equal(r.ok, true);
  assert.equal(readState(root, runId).data.autonomy.session_effort, 'low');
});

test('setSessionProfile invalid value throws and does not mutate', () => {
  const { root, runId } = seed();
  const seq0 = readState(root, runId).data.event_log_head.seq;
  assert.throws(() => setSessionProfile(root, runId, { effort: 'bogus', expect: expect_(runId), now: 1 }), /INVALID_EFFORT/);
  assert.throws(() => setSessionProfile(root, runId, { model: '-p', expect: expect_(runId), now: 1 }), /INVALID_MODEL/);
  assert.equal(readState(root, runId).data.event_log_head.seq, seq0);
});

const CLI = fileURLToPath(new URL('../scripts/deep-loop.mjs', import.meta.url));
function cli(root, args) {
  return spawnSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
}

test('CLI session-profile set: exit codes', () => {
  const { root, runId } = seed();
  let r = cli(root, ['session-profile', 'set', '--model', 'opus', '--effort', 'high', '--owner', runId, '--generation', '1']);
  assert.equal(r.status, 0);
  assert.equal(readState(root, runId).data.autonomy.session_effort, 'high');
  r = cli(root, ['session-profile', 'set', '--effort', 'ultra', '--owner', runId, '--generation', '1']);
  assert.equal(r.status, 1);
  r = cli(root, ['session-profile', 'set', '--effort', 'low', '--owner', runId, '--generation', '2']);
  assert.equal(r.status, 3);
  r = cli(root, ['session-profile', 'bogus', '--owner', runId, '--generation', '1']);
  assert.equal(r.status, 2);
});

test('setSessionProfile partial-update event omits the absent field (no null clear)', () => {
  const { root, runId } = seed();
  setSessionProfile(root, runId, { model: 'opus', effort: 'high', expect: expect_(runId), now: 1 });
  setSessionProfile(root, runId, { effort: 'low', expect: expect_(runId), now: 2 }); // model omitted
  const lines = readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const evts = lines.filter((e) => e.type === 'session-profile-set');
  const last = evts[evts.length - 1];
  assert.equal(last.data.effort, 'low');
  assert.ok(!('model' in last.data), 'partial update event must NOT record an omitted model field');
});

test('CLI rejects value-less --model/--effort as usage (exit 2)', () => {
  const { root, runId } = seed();
  // `--model --effort high`: parseFlags consumes --effort as --model's (missing) value → f.model===true
  let r = cli(root, ['session-profile', 'set', '--model', '--effort', 'high', '--owner', runId, '--generation', '1']);
  assert.equal(r.status, 2, 'value-less --model → usage exit 2');
  // state untouched (no silent partial write)
  assert.equal(readState(root, runId).data.autonomy.session_effort, undefined);
  r = cli(root, ['init-run', '--goal', 'g', '--runtime', 'claude', '--model']);
  assert.equal(r.status, 2, 'value-less --model on init-run → usage exit 2');
});

test('CLI supports --key=value form for --model/--effort (WS1 parseFlags)', () => {
  const { root, runId } = seed();
  const r = cli(root, ['session-profile', 'set', '--model=claude-opus-4-8[1m]', '--effort=xhigh', '--owner', runId, '--generation', '1']);
  assert.equal(r.status, 0);
  const { data } = readState(root, runId);
  assert.equal(data.autonomy.session_model, 'claude-opus-4-8[1m]');
  assert.equal(data.autonomy.session_effort, 'xhigh');
});
