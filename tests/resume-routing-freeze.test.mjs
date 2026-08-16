import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { emitHandoff as emitHandoffImpl } from '../scripts/lib/handoff.mjs';
import { respawn as respawnImpl } from '../scripts/lib/respawn.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { setSessionProfile, resolveLaunchProfile } from '../scripts/lib/session-profile.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';
import { buildRoutingRecord } from '../scripts/lib/router-adapter.mjs';

const NOW0 = new Date('2026-06-24T00:00:00Z');
const NOW1 = Date.parse('2026-06-24T01:00:00Z');
const POLICY_A = 'a'.repeat(64);

function noOpRun() { return { code: 1 }; }

function routingFixture() {
  return buildRoutingRecord(
    {
      route_schema_version: 1,
      task_class: 'IMPLEMENTATION',
      complexity: 1,
      uncertainty: 1,
      blast_radius: 0,
      reversibility: 0,
    },
    {
      route_schema_version: 1,
      router_plugin_version: '1.0.0',
      policy_sha256: POLICY_A,
      selected_model: 'claude-sonnet-5',
      selected_effort_native: 'low',
      effective_policy: { minimum_effort: null },
    },
  );
}

function seedLauncher() {
  const root = mkdtempSync(join(tmpdir(), 'dl-resume-route-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: NOW0, env: {}, platform: 'linux', run: noOpRun,
  });
  migrateAuthenticLegacyTransport(root, runId);
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'headless';
  data.autonomy.session_model = 'claude-opus-4-8[1m]';
  data.autonomy.session_effort = 'xhigh';
  data.session_spawn = {
    platform: 'linux', launcher: 'cmux',
    launcher_bin: '/abs/bin/cmux', launcher_socket: '/tmp/cmux.sock',
    surface: 'multiplexer', reachable: true, visible: true, signals: {}, probe: null,
    reason: 'detected', fallback: 'launch-command-file', detected_at: '2026-06-24T00:00:00Z',
  };
  writeState(root, runId, data);
  return { root, runId };
}

function targetPlatform(root, runId, options = {}) {
  return options.platform ?? readState(root, runId).data.session_spawn?.platform ?? 'linux';
}

function emitHandoff(root, runId, options = {}) {
  return emitHandoffImpl(root, runId, { ...options, platform: targetPlatform(root, runId, options) });
}

function respawn(root, runId, options = {}) {
  return respawnImpl(root, runId, { ...options, platform: targetPlatform(root, runId, options) });
}

function plantInProgressRouting(root, runId) {
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const ws = newWorkstream(root, runId, {
    title: 'live', branch: 'live', worktree: '.claude/worktrees/live', fence,
  }).id;
  writeFileSync(join(root, 'art.txt'), 'x');
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: ['art.txt'], fence,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', routing: routingFixture(), fence });
  return { id, ws, fence };
}

test('resolveLaunchProfile consumes frozen episode.routing and never calls the locator', () => {
  const { root, runId } = seedLauncher();
  const { id } = plantInProgressRouting(root, runId);
  let locateCalls = 0;
  const locate = () => {
    locateCalls += 1;
    throw new Error('locator must not run for an in_progress episode');
  };
  const profile = resolveLaunchProfile(readState(root, runId).data, { episodeId: id, locate });
  assert.deepEqual(profile, {
    model: 'claude-sonnet-5',
    effort: 'low',
    source: 'episode.routing',
    provenance: 'router',
  });
  assert.equal(locateCalls, 0);
});

test('resolveLaunchProfile binds the current episode, not the first routed in_progress', () => {
  const { root, runId } = seedLauncher();
  const first = plantInProgressRouting(root, runId);
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const otherWs = newWorkstream(root, runId, {
    title: 'other', branch: 'other', worktree: '.claude/worktrees/other', fence,
  }).id;
  writeFileSync(join(root, 'other.txt'), 'y');
  const { id: secondId } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: otherWs, expectedArtifacts: ['other.txt'], fence,
  });
  recordEpisode(root, runId, secondId, { status: 'in_progress', fence });
  const after = readState(root, runId).data;
  assert.equal(after.current_episode, secondId);
  const unbound = resolveLaunchProfile(after);
  assert.equal(unbound.source, 'session_profile');
  assert.equal(unbound.model, 'claude-opus-4-8[1m]');
  const boundFirst = resolveLaunchProfile(after, { episodeId: first.id });
  assert.equal(boundFirst.source, 'episode.routing');
  assert.equal(boundFirst.model, 'claude-sonnet-5');
});

test('missing episode.routing degrades to session_profile without invoking the locator', () => {
  const { root, runId } = seedLauncher();
  let locateCalls = 0;
  const profile = resolveLaunchProfile(readState(root, runId).data, {
    locate: () => { locateCalls += 1; return '/tmp/route_task.py'; },
  });
  assert.deepEqual(profile, {
    model: 'claude-opus-4-8[1m]',
    effort: 'xhigh',
    source: 'session_profile',
    provenance: 'local-fallback',
  });
  assert.equal(locateCalls, 0);
});

test('setSessionProfile must not overwrite a frozen episode.routing', () => {
  const { root, runId } = seedLauncher();
  const { id } = plantInProgressRouting(root, runId);
  const before = structuredClone(readState(root, runId).data.episodes.find((item) => item.id === id).routing);
  setSessionProfile(root, runId, {
    model: 'claude-haiku-4-5-20251001',
    effort: 'medium',
    expect: { owner: runId, generation: 1 },
  });
  const after = readState(root, runId).data;
  assert.equal(after.autonomy.session_model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(after.episodes.find((item) => item.id === id).routing, before);
  const profile = resolveLaunchProfile(after, { episodeId: id });
  assert.equal(profile.source, 'episode.routing');
  assert.equal(profile.model, 'claude-sonnet-5');
});

test('respawn threads frozen episode.routing into the child and never re-invokes the router', () => {
  const { root, runId } = seedLauncher();
  plantInProgressRouting(root, runId);
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: { owner: runId, generation: 1 } });
  let captured = null;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    headless: true, now: NOW1 + 1000,
    spawnFn: (entry) => { captured = entry; return { ok: true, usage: { num_turns: 1, tokens: 1 } }; },
    locateRouter: () => { throw new Error('respawn must not locate the router'); },
  });
  assert.equal(r.ok, true, r.reason);
  assert.ok(captured, 'spawnFn was called');
  assert.ok(captured.argv.includes('--model') && captured.argv.includes('claude-sonnet-5'));
  assert.ok(captured.argv.includes('--effort') && captured.argv.includes('low'));
  assert.equal(captured.argv.includes('claude-opus-4-8[1m]'), false);
  assert.equal(captured.argv.includes('xhigh'), false);
});

test('respawn without episode.routing still propagates session_profile', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: { owner: runId, generation: 1 } });
  let captured = null;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    headless: true, now: NOW1 + 1000,
    spawnFn: (entry) => { captured = entry; return { ok: true, usage: { num_turns: 1, tokens: 1 } }; },
  });
  assert.equal(r.ok, true);
  assert.ok(captured.argv.includes('claude-opus-4-8[1m]'));
  assert.ok(captured.argv.includes('xhigh'));
});

test('in_progress and done resume sources do not import the locator', () => {
  for (const rel of [
    'scripts/lib/session-profile.mjs',
    'scripts/lib/respawn.mjs',
    'scripts/lib/episode.mjs',
    'scripts/lib/review.mjs',
  ]) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /locate-deep-model-router|locateDeepModelRouter|route_task\.py/);
  }
});
