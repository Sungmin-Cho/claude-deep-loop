import { test } from 'node:test';
import assert from 'node:assert/strict';

async function descriptorModule() {
  try {
    return await import('../scripts/lib/runtime-descriptor.mjs');
  } catch (error) {
    assert.fail(`runtime descriptor module must load: ${error?.code || error}`);
  }
}

const base = {
  root: '/repo with space',
  platform: 'linux',
  parentRunId: '01PARENT',
  childRunId: '01CHILD',
  handoffRel: 'handoffs/next.md',
};

test('runtime helpers select the host-native resume token and usage output kind', async () => {
  const { resumeSkillToken, usageOutputKind } = await descriptorModule();
  assert.equal(resumeSkillToken('claude'), '/deep-loop-resume');
  assert.equal(usageOutputKind('claude'), 'claude-json');
  assert.equal(resumeSkillToken('codex'), '$deep-loop:deep-loop-resume');
  assert.equal(usageOutputKind('codex'), 'codex-jsonl');
});

test('runtime descriptor freezes a minimal root/run/runtime contract', async () => {
  const { buildRuntimeResumeDescriptor } = await descriptorModule();
  const descriptor = buildRuntimeResumeDescriptor({ ...base, runtime: 'codex' });
  assert.deepEqual({
    runtime: descriptor.runtime,
    projectRoot: descriptor.projectRoot,
    runId: descriptor.runId,
    childRunId: descriptor.childRunId,
    handoffRel: descriptor.handoffRel,
    resumeSkillToken: descriptor.resumeSkillToken,
    usageOutputKind: descriptor.usageOutputKind,
  }, {
    runtime: 'codex',
    projectRoot: base.root,
    runId: base.parentRunId,
    childRunId: base.childRunId,
    handoffRel: base.handoffRel,
    resumeSkillToken: '$deep-loop:deep-loop-resume',
    usageOutputKind: 'codex-jsonl',
  });
  assert.ok(descriptor.resumePrompt.includes(base.root));
  assert.ok(descriptor.resumePrompt.includes(base.parentRunId));
  assert.ok(descriptor.resumePrompt.includes('$deep-loop:deep-loop-resume'));
});

test('legacy/default launch command remains byte-compatible with explicit Claude runtime', async () => {
  const { buildLaunchCommand, buildRuntimeResumeDescriptor } = await descriptorModule();
  const legacy = buildLaunchCommand(base);
  const explicit = buildLaunchCommand({ ...base, runtime: 'claude' });
  assert.deepEqual(legacy, explicit);
  assert.deepEqual(explicit, buildRuntimeResumeDescriptor({ ...base, runtime: 'claude' }).entries);
  assert.equal(explicit.headless.bin, 'claude');
  assert.deepEqual(explicit.headless.argv, [
    '-p',
    'Read .deep-loop/runs/01PARENT/handoffs/next.md first; then run /deep-loop-resume',
    '--output-format', 'json', '--permission-mode', 'acceptEdits',
  ]);
});

test('Codex Slice 1 descriptor is manual/fail-closed and never emits Claude transport flags', async () => {
  const { buildRuntimeResumeDescriptor } = await descriptorModule();
  const descriptor = buildRuntimeResumeDescriptor({
    ...base,
    runtime: 'codex',
    model: 'claude-opus-4-8[1m]',
    effort: 'xhigh',
  });
  const unavailable = ['cmux', 'iterm2', 'terminal-app', 'wt', 'powershell', 'headless'];
  for (const name of unavailable) {
    assert.equal(descriptor.entries[name].unavailable, true, name);
    assert.equal(descriptor.entries[name].reason, 'codex-transport-not-activated', name);
    assert.equal(descriptor.entries[name].bin, undefined, name);
  }
  assert.equal(descriptor.entries.interactive.manual, true);
  assert.match(descriptor.entries.interactive.display, /\$deep-loop:deep-loop-resume/);
  assert.match(descriptor.entries.interactive.display, /01PARENT/);

  const app = descriptor.entries.desktop;
  assert.equal(app.manual, true);
  assert.equal(app.unavailable, true);
  assert.equal(app.reason, 'codex-transport-not-activated');
  assert.match(app.display, /Codex App/);
  assert.match(app.display, /\$deep-loop:deep-loop-resume/);
  assert.equal(app.bin, undefined);
  assert.equal(app.argv, undefined);

  const serialized = JSON.stringify(descriptor);
  assert.ok(!serialized.includes('claude://'), 'Codex App descriptor must not invent a private URL');
  assert.ok(!serialized.includes('--model'), 'Claude --model flag must not leak into Codex output');
  assert.ok(!serialized.includes('--effort'), 'Claude --effort flag must not leak into Codex output');
  assert.ok(!serialized.includes('"bin":"claude"'), 'Codex must not route through the Claude process');
});

test('fork App prompt is bounded, self-contained, and honest about history', async () => {
  const { APP_RESUME_PROMPT_MAX_BYTES, buildAppResumePrompt } = await descriptorModule();
  const prompt = buildAppResumePrompt({
    projectRoot: '/repo', targetCwd: '/repo/.claude/worktrees/ws', platform: 'linux',
    logicalRunId: '01JAPPRAN00000000000000000',
    parentRunId: '01JAPPPAR00000000000000000',
    childRunId: '01JAPPCHD00000000000000015',
    parentGeneration: 4, attemptId: '01JAPPTASK0000000000000000', route: 'fork',
    contextMode: 'inherited-completed-history',
    handoffRel: 'handoffs/next.md', workstreamId: 'WS-1',
  });
  for (const value of [
    'logical_run_id="01JAPPRAN00000000000000000"',
    'parent_run_id="01JAPPPAR00000000000000000"',
    'reserved_child_run_id="01JAPPCHD00000000000000015"',
    'app_attempt_id="01JAPPTASK0000000000000000"',
    'workstream_id="WS-1"', '$deep-loop:deep-loop-resume', 'session-profile set',
  ]) {
    assert.ok(prompt.includes(value));
  }
  assert.match(prompt, /completed history/i);
  assert.match(prompt, /active turn.*unfinished response/i);
  assert.match(prompt, /status.*confirmed.*acquire/is);
  assert.match(prompt, /handoff.*loop state.*source of truth/is);
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= APP_RESUME_PROMPT_MAX_BYTES);
  assert.doesNotMatch(prompt, /project[_-]?id|thread[_-]?id|host response|model|thinking|claude:\/\/|\bcodex exec\b/i);
});

test('App prompt rejects path controls, route drift, and oversize paths', async () => {
  const { buildAppResumePrompt } = await descriptorModule();
  const base = {
    projectRoot: '/repo', targetCwd: '/repo/.claude/worktrees/ws', platform: 'linux',
    logicalRunId: '01JAPPRAN00000000000000000',
    parentRunId: '01JAPPPAR00000000000000000',
    childRunId: '01JAPPCHD00000000000000015',
    parentGeneration: 4, attemptId: '01JAPPTASK0000000000000000', route: 'fork',
    contextMode: 'inherited-completed-history',
    handoffRel: 'handoffs/next.md', workstreamId: 'WS-1',
  };
  for (const field of ['projectRoot', 'targetCwd']) {
    assert.throws(() => buildAppResumePrompt({ ...base, [field]: `${base[field]}\nINJECT` }),
      /APP_PROMPT_PATH_INVALID/);
    assert.throws(() => buildAppResumePrompt({ ...base, [field]: `${base[field]}\0INJECT` }),
      /APP_PROMPT_PATH_INVALID/);
    for (const separator of ['\u2028', '\u2029']) {
      assert.throws(() => buildAppResumePrompt({
        ...base, [field]: `${base[field]}${separator}route="create"`,
      }), /APP_PROMPT_PATH_INVALID/);
    }
  }
  assert.throws(() => buildAppResumePrompt({ ...base, projectRoot: `/${'x'.repeat(4097)}` }), /APP_PROMPT_PATH_INVALID/);
  assert.throws(() => buildAppResumePrompt({ ...base, contextMode: 'fresh' }), /APP_PROMPT_ROUTE_INVALID/);
  for (const field of ['logicalRunId', 'parentRunId', 'childRunId', 'attemptId']) {
    assert.throws(() => buildAppResumePrompt({ ...base, [field]: 'A' }), /APP_PROMPT_ID_INVALID/);
  }
  assert.throws(() => buildAppResumePrompt({
    ...base, parentGeneration: Number.MAX_SAFE_INTEGER + 1,
  }), /APP_PROMPT_GENERATION_INVALID/);
});
