import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalRealpath } from './helpers/fs-fixtures.mjs';

async function checkerModule() {
  try {
    return await import('../scripts/lib/codex-checker.mjs');
  } catch (error) {
    assert.fail(`codex checker module must load: ${error?.code || error}`);
  }
}

function contract(root) {
  return {
    schema_version: '1.0',
    reviewer_id: 'deep-review',
    checker_episode_id: '002-deep-review',
    target_maker: '001-deep-work',
    attempt_id: 'attempt-01',
    workstream_id: 'ws-1',
    point: 'implementation',
    project_root: root,
    artifacts: [{ path: '.claude/worktrees/w/artifact.txt', sha256: 'a'.repeat(64) }],
  };
}

test('buildCodexCheckerPrompt narrows the installed skill to one immutable read-only review contract', async () => {
  const { buildCodexCheckerPrompt } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-prompt-')));
  const skillPath = join(root, 'SKILL.md');
  writeFileSync(skillPath, '---\nname: deep-review-loop\n---\n');
  const prompt = buildCodexCheckerPrompt({ ...contract(root), checker_skill_path: skillPath });
  assert.match(prompt, /single independent read-only review pass/i);
  assert.match(prompt, /do not.*respond/i);
  assert.match(prompt, /do not.*write/i);
  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /workstream_id, point, and project_root are context-only/i);
  assert.match(prompt, /echo only schema_version, reviewer_id, checker_episode_id, target_maker, attempt_id, and artifacts/i);
  assert.ok(prompt.includes(JSON.stringify(skillPath)));
  assert.ok(prompt.includes('"attempt_id":"attempt-01"'));
});

test('checker prompt canonicalizes contract JSON independent of caller property order', async () => {
  const { buildCodexCheckerPrompt } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-canonical-')));
  const skillPath = join(root, 'SKILL.md');
  writeFileSync(skillPath, '---\nname: deep-review-loop\n---\n');
  const original = { ...contract(root), checker_skill_path: skillPath };
  const reversed = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(buildCodexCheckerPrompt(original), buildCodexCheckerPrompt(reversed));
});

test('runIndependentCodexChecker builds one fresh read-only schema-bound shell-free Codex entry', async () => {
  const { runIndependentCodexChecker } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-entry-')));
  const skillPath = join(root, 'SKILL.md');
  const schemaPath = join(root, 'review-import.schema.json');
  writeFileSync(skillPath, '---\nname: deep-review-loop\n---\n');
  writeFileSync(schemaPath, '{}');
  let captured;
  const expectedFinal = Buffer.from('{"exact":"bytes 한글"}');
  const result = runIndependentCodexChecker({
    executable: '/opt/codex/bin/codex',
    projectRoot: root,
    checkerSkillPath: skillPath,
    outputSchemaPath: schemaPath,
    contract: contract(root),
    model: 'gpt-5.4',
    effort: 'xhigh',
    env: { CODEX_HOME: '/home/test/.codex' },
    timeoutMs: 1_234,
    runProcess: (entry, options) => {
      captured = { entry, options };
      return {
        ok: true,
        usage: { num_turns: 1, tokens: 12, input_tokens: 5, output_tokens: 7 },
        finalMessage: expectedFinal,
      };
    },
  });

  assert.equal(captured.entry.bin, '/opt/codex/bin/codex');
  assert.equal(captured.entry.shell, false);
  assert.equal(captured.entry.cwd, root);
  assert.deepEqual(captured.entry.env, { CODEX_HOME: '/home/test/.codex' });
  assert.equal(captured.entry.usageOutputKind, 'codex-jsonl');
  assert.equal(captured.entry.captureFinalMessage, true);
  assert.ok(captured.entry.argv.includes('--ephemeral'));
  assert.ok(captured.entry.argv.includes('--json'));
  assert.deepEqual(captured.entry.argv.slice(captured.entry.argv.indexOf('--sandbox'), captured.entry.argv.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.deepEqual(captured.entry.argv.slice(captured.entry.argv.indexOf('--output-schema'), captured.entry.argv.indexOf('--output-schema') + 2), ['--output-schema', schemaPath]);
  assert.equal(captured.entry.argv.at(-1), '-');
  assert.equal(captured.entry.stdin.includes(JSON.stringify(skillPath)), true);
  assert.deepEqual(captured.options, { timeoutMs: 1_234 });
  assert.equal(result.finalMessage.equals(expectedFinal), true);
});

test('runIndependentCodexChecker preserves an exact measured turn when the final message is missing', async () => {
  const { runIndependentCodexChecker } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-missing-final-')));
  const skillPath = join(root, 'SKILL.md');
  const schemaPath = join(root, 'review-import.schema.json');
  writeFileSync(skillPath, '---\nname: deep-review-loop\n---\n');
  writeFileSync(schemaPath, '{}');
  const usage = { num_turns: 1, tokens: 12, input_tokens: 5, output_tokens: 7 };

  const result = runIndependentCodexChecker({
    executable: '/opt/codex/bin/codex',
    projectRoot: root,
    checkerSkillPath: skillPath,
    outputSchemaPath: schemaPath,
    contract: contract(root),
    env: { CODEX_HOME: '/home/test/.codex' },
    timeoutMs: 1_234,
    runProcess: () => ({ ok: true, usage }),
  });

  assert.deepEqual(result, { ok: false, reason: 'checker-final-message-invalid', usage });
});

test('importReviewViaCli forwards the identical Buffer through trusted Node argv with bounded shell-free IO', async () => {
  const { importReviewViaCli } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-import-')));
  const kernelPath = join(root, 'deep-loop.mjs');
  writeFileSync(kernelPath, '');
  const raw = Buffer.from('  {"multibyte":"한글"}\n');
  let observed;
  const result = importReviewViaCli({
    processExecutable: process.execPath,
    kernelPath,
    projectRoot: root,
    runId: 'RUN-1',
    owner: 'OWNER-1',
    generation: 7,
    timeoutMs: 9_999,
    env: { PATH: '/trusted/bin' },
    spawnSyncImpl: (bin, argv, options) => {
      observed = { bin, argv, options };
      return { status: 0, signal: null, stdout: '{"ok":true}\n', stderr: '' };
    },
  }, raw);

  assert.equal(observed.bin, process.execPath);
  assert.equal(observed.argv[0], kernelPath);
  assert.deepEqual(observed.argv.slice(1), [
    'review', 'import', '--project-root', root, '--run-id', 'RUN-1',
    '--owner', 'OWNER-1', '--generation', '7', '--stdin',
  ]);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.cwd, root);
  assert.deepEqual(observed.options.env, { PATH: '/trusted/bin' });
  assert.equal(observed.options.input, raw);
  assert.equal(observed.options.timeout, 9_999);
  assert.deepEqual(result, { ok: true, value: { ok: true } });
});

test('trusted checker skill resolution accepts one exact cache candidate and rejects missing or ambiguous candidates', async () => {
  const { resolveTrustedCheckerSkill } = await checkerModule();
  const home = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-home-')));
  const cache = join(home, 'plugins', 'cache');
  mkdirSync(cache, { recursive: true });
  assert.throws(() => resolveTrustedCheckerSkill({ codexHome: home }), /checker-skill-unavailable/);

  const install = (name) => {
    const plugin = join(cache, 'market', 'deep-review', name);
    mkdirSync(join(plugin, '.codex-plugin'), { recursive: true });
    mkdirSync(join(plugin, 'skills', 'deep-review-loop'), { recursive: true });
    writeFileSync(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'deep-review', version: name, skills: './skills/',
    }));
    writeFileSync(join(plugin, 'skills', 'deep-review-loop', 'SKILL.md'), '---\nname: deep-review-loop\n---\n# review\n');
    return plugin;
  };
  const only = install('1.0.0');
  const resolved = resolveTrustedCheckerSkill({ codexHome: home });
  assert.equal(resolved.plugin_directory.canonical_path, only);
  assert.equal(resolved.manifest.canonical_path, join(only, '.codex-plugin', 'plugin.json'));
  assert.equal(resolved.skill.canonical_path, join(only, 'skills', 'deep-review-loop', 'SKILL.md'));

  install('2.0.0');
  assert.throws(() => resolveTrustedCheckerSkill({ codexHome: home }), /checker-skill-ambiguous/);
});
