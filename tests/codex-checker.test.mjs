import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalRealpath } from './helpers/fs-fixtures.mjs';
import { writeExactDualCapture } from './helpers/dual-capture.mjs';

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

test('dual Codex checker entry fixes the concrete model and requests trusted provider identity capture', async () => {
  const { buildCodexCheckerEntry, buildCodexCheckerPrompt } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-dual-codex-entry-')));
  const skillPath = join(root, 'SKILL.md');
  const schemaPath = join(root, 'review-import.schema.json');
  writeFileSync(skillPath, '---\nname: deep-review-loop\n---\n');
  writeFileSync(schemaPath, '{}');
  const dualContract = {
    schema_version: '2.0', aggregation_id: 'aggregation-1', reviewer_id: 'deep-review',
    reviewer_adapter: 'codex-checker', provider_id: 'openai-codex', model_id: 'gpt-5.6-sol',
    session_id: 'provider-session-bound-by-host', checker_episode_id: '002-deep-review',
    target_maker: '001-deep-work', attempt_id: 'attempt-codex',
    source_claim_sha256: 'a'.repeat(64), artifacts: [],
    review_context: { workstream_id: 'ws-1', point: 'implementation', project_root: root },
  };
  const entry = buildCodexCheckerEntry({
    executable: '/opt/codex/bin/codex', projectRoot: root, checkerSkillPath: skillPath,
    outputSchemaPath: schemaPath, contract: dualContract, env: {},
    model: 'gpt-5.6-sol', effort: 'xhigh', captureProviderIdentity: true,
  });
  assert.equal(entry.captureProviderIdentity, true);
  assert.equal(entry.captureFinalMessage, true);
  assert.equal(entry.captureProcessDiagnostic, true);
  assert.equal(entry.usageOutputKind, 'codex-jsonl');
  assert.deepEqual(entry.argv.slice(entry.argv.indexOf('--model'), entry.argv.indexOf('--model') + 2), [
    '--model', 'gpt-5.6-sol',
  ]);
  assert.ok(entry.argv.includes('model_reasoning_effort="xhigh"'));
  const prompt = buildCodexCheckerPrompt({ ...dualContract, checker_skill_path: skillPath });
  assert.match(prompt, /aggregation_id, reviewer_id, reviewer_adapter, provider_id, model_id, session_id, checker_episode_id, target_maker, attempt_id, source_claim_sha256, and artifacts/i);
  assert.match(prompt, /review_context is context-only/i);
});

test('runIndependentCodexChecker preserves an exact measured turn when the final message is missing', async () => {
  const { runIndependentCodexChecker } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-missing-final-')));
  const skillPath = join(root, 'SKILL.md');
  const schemaPath = join(root, 'review-import.schema.json');
  writeFileSync(skillPath, '---\nname: deep-review-loop\n---\n');
  writeFileSync(schemaPath, '{}');
  const usage = { num_turns: 1, tokens: 12, input_tokens: 5, output_tokens: 7 };

  const processStreams = {
    stderr: { sha256: 'a'.repeat(64), byte_count: 0, truncated: false },
    stdout: { sha256: 'b'.repeat(64), byte_count: 7, truncated: false },
  };
  const result = runIndependentCodexChecker({
    executable: '/opt/codex/bin/codex',
    projectRoot: root,
    checkerSkillPath: skillPath,
    outputSchemaPath: schemaPath,
    contract: contract(root),
    env: { CODEX_HOME: '/home/test/.codex' },
    timeoutMs: 1_234,
    runProcess: () => ({ ok: true, usage, process_streams: processStreams }),
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'checker-final-message-invalid',
    usage,
    process_diagnostic: {
      reason_code: 'checker-final-message-invalid',
      process_phase: 'final-message',
      ...processStreams,
    },
  });
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

test('importReviewViaCli returns only closed byte metadata for granular import failures', async () => {
  const { importReviewViaCli } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-import-diagnostic-')));
  const kernelPath = join(root, 'deep-loop.mjs');
  writeFileSync(kernelPath, '');
  const input = Buffer.from('{"secret":"INPUT_SECRET"}');
  const stdout = Buffer.from('STDOUT_SECRET');
  const stderr = Buffer.from('STDERR_SECRET');
  const result = importReviewViaCli({
    processExecutable: process.execPath, kernelPath, projectRoot: root,
    runId: 'RUN-1', owner: 'OWNER-1', generation: 7,
    spawnSyncImpl: () => ({ status: 23, signal: null, stdout, stderr }),
  }, input);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'checker-import-failed');
  assert.deepEqual(result.import_diagnostic, {
    reason_code: 'import-nonzero-exit', import_phase: 'child-execution',
    input: { sha256: '0db58f586b340907445885e76d289b168d54c376bde557488e7b37faee8acc7f', byte_count: 25, truncated: false },
    stdout: { sha256: '299d37ae77035229bcb4b30ffdd6d736da524d1cdc10e43cf95cc3bb5d7c2fa3', byte_count: 13, truncated: false },
    stderr: { sha256: 'bfc2a1e721925ebfea42691ebb4b489a87d47f1c0a0394ee67b235f8f02fbd3e', byte_count: 13, truncated: false },
  });
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('SECRET'), false);
  assert.equal(encoded.includes('/tmp'), false);
  assert.equal(result.import_diagnostic.reason_code.includes('23'), false,
    'exit status is not durable diagnostic vocabulary');
});

test('importReviewViaCli closes every process and protocol failure phase', async () => {
  const { importReviewViaCli } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-import-phases-')));
  const kernelPath = join(root, 'deep-loop.mjs');
  writeFileSync(kernelPath, '');
  const base = { processExecutable: process.execPath, kernelPath, projectRoot: root, runId: 'R', owner: 'O', generation: 1 };
  for (const [label, spawnSyncImpl, reason_code, import_phase, truncated] of [
    ['spawn throw', () => { throw new Error('SECRET'); }, 'import-spawn-failed', 'child-spawn', false],
    ['timeout', () => ({ error: { code: 'ETIMEDOUT' }, stdout: 'partial', stderr: '' }), 'import-timeout', 'child-execution', false],
    ['overflow', () => ({ error: { code: 'ENOBUFS' }, stdout: 'partial', stderr: '' }), 'import-spawn-failed', 'child-spawn', true],
    ['terminated', () => ({ signal: 'SIGKILL', stdout: '', stderr: '' }), 'import-terminated', 'child-execution', false],
    ['invalid output', () => ({ status: 0, signal: null, stdout: 'SECRET-not-json', stderr: '' }), 'import-output-invalid', 'output-parse', false],
  ]) {
    const result = importReviewViaCli({ ...base, spawnSyncImpl }, Buffer.from('{}'));
    assert.equal(result.import_diagnostic.reason_code, reason_code, label);
    assert.equal(result.import_diagnostic.import_phase, import_phase, label);
    assert.equal(result.import_diagnostic.stdout.truncated, truncated, label);
    assert.equal(JSON.stringify(result).includes('SECRET'), false, label);
  }
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

test('trusted checker capture publishes exact run-owned bytes and tolerates source metadata replacement', async () => {
  const { captureTrustedCheckerSkill, resolveTrustedCheckerSkill } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-capture-')));
  const runId = 'RUN-1';
  const sourceClaimSha256 = 'a'.repeat(64);
  mkdirSync(join(root, '.deep-loop', 'runs', runId), { recursive: true });
  const home = join(root, 'codex-home');
  const plugin = join(home, 'plugins', 'cache', 'market', 'deep-review', '1.0.0');
  const manifestPath = join(plugin, '.codex-plugin', 'plugin.json');
  const skillPath = join(plugin, 'skills', 'deep-review-loop', 'SKILL.md');
  mkdirSync(join(plugin, '.codex-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'skills', 'deep-review-loop'), { recursive: true });
  const manifestBytes = Buffer.from('{"name":"deep-review","version":"1.0.0","skills":"./skills/"}');
  const skillBytes = Buffer.from('---\nname: deep-review-loop\n---\n# trusted\n');
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(skillPath, skillBytes);
  const source = resolveTrustedCheckerSkill({ codexHome: home });
  const captured = captureTrustedCheckerSkill({
    root, runId, checkerEpisodeId: '002-deep-review', attemptId: 'attempt-01',
    sourceClaimSha256, source,
  });
  assert.deepEqual(readdirSync(captured.directory.canonical_path).sort(), ['SKILL.md', 'capture.json', 'plugin.json']);
  assert.equal(readFileSync(captured.manifest.canonical_path).equals(manifestBytes), true);
  assert.equal(readFileSync(captured.skill.canonical_path).equals(skillBytes), true);
  assert.equal(lstatSync(captured.directory.canonical_path).isSymbolicLink(), false);
  assert.equal(lstatSync(captured.skill.canonical_path).isFile(), true);
  const record = JSON.parse(readFileSync(captured.record.canonical_path, 'utf8'));
  assert.deepEqual(Object.keys(record), ['schema_version', 'binding', 'source', 'captured']);
  assert.deepEqual(record.binding, {
    run_id: runId, checker_episode_id: '002-deep-review', attempt_id: 'attempt-01',
    source_claim_sha256: sourceClaimSha256,
  });
  assert.equal(record.source.plugin_version, '1.0.0');
  assert.deepEqual(record.captured, {
    manifest_rel: 'plugin.json', manifest_sha256: source.manifest.sha256,
    skill_rel: 'SKILL.md', skill_sha256: source.skill.sha256,
  });
  const capturedBytes = {
    manifest: readFileSync(captured.manifest.canonical_path),
    skill: readFileSync(captured.skill.canonical_path),
    record: readFileSync(captured.record.canonical_path),
  };

  const replacementManifest = `${manifestPath}.replacement`;
  const replacementSkill = `${skillPath}.replacement`;
  writeFileSync(replacementManifest, manifestBytes);
  writeFileSync(replacementSkill, skillBytes);
  renameSync(replacementManifest, manifestPath);
  renameSync(replacementSkill, skillPath);
  const replaced = resolveTrustedCheckerSkill({ codexHome: home });
  assert.equal(replaced.plugin_directory.canonical_path, source.plugin_directory.canonical_path);
  assert.equal(replaced.manifest.sha256, source.manifest.sha256);
  assert.equal(replaced.skill.sha256, source.skill.sha256);
  assert.deepEqual(captureTrustedCheckerSkill({
    root, runId, checkerEpisodeId: '002-deep-review', attemptId: 'attempt-01',
    sourceClaimSha256, source: replaced, expected: captured,
  }), captured);
  assert.equal(readFileSync(captured.manifest.canonical_path).equals(capturedBytes.manifest), true);
  assert.equal(readFileSync(captured.skill.canonical_path).equals(capturedBytes.skill), true);
  assert.equal(readFileSync(captured.record.canonical_path).equals(capturedBytes.record), true);

  writeFileSync(replacementSkill, Buffer.from('---\nname: deep-review-loop\n---\n# changed\n'));
  renameSync(replacementSkill, skillPath);
  const changed = resolveTrustedCheckerSkill({ codexHome: home });
  assert.throws(() => captureTrustedCheckerSkill({
    root, runId, checkerEpisodeId: '002-deep-review', attemptId: 'attempt-01',
    sourceClaimSha256, source: changed, expected: captured,
  }), /checker-source-skill-content-drift/);
});

test('trusted checker capture rejects byte-identical capture replacement', async () => {
  const { captureTrustedCheckerSkill, resolveTrustedCheckerSkill } = await checkerModule();
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-checker-capture-drift-')));
  const runId = 'RUN-1';
  const sourceClaimSha256 = 'b'.repeat(64);
  mkdirSync(join(root, '.deep-loop', 'runs', runId), { recursive: true });
  const home = join(root, 'codex-home');
  const plugin = join(home, 'plugins', 'cache', 'market', 'deep-review', '1.0.0');
  mkdirSync(join(plugin, '.codex-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'skills', 'deep-review-loop'), { recursive: true });
  writeFileSync(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'deep-review', version: '1.0.0', skills: './skills/',
  }));
  writeFileSync(join(plugin, 'skills', 'deep-review-loop', 'SKILL.md'), '---\nname: deep-review-loop\n---\n');
  const source = resolveTrustedCheckerSkill({ codexHome: home });
  const captured = captureTrustedCheckerSkill({
    root, runId, checkerEpisodeId: '002-deep-review', attemptId: 'attempt-01',
    sourceClaimSha256, source,
  });
  const bytes = readFileSync(captured.skill.canonical_path);
  unlinkSync(captured.skill.canonical_path);
  writeFileSync(captured.skill.canonical_path, bytes, { mode: 0o400 });
  assert.throws(() => captureTrustedCheckerSkill({
    root, runId, checkerEpisodeId: '002-deep-review', attemptId: 'attempt-01',
    sourceClaimSha256, source, expected: captured,
  }), /checker-capture-integrity-drift:skill/);
});

test('retained capture consumer derives exact manifest, skill, version, and source topology semantics', async () => {
  const { captureTrustedCheckerSkill } = await checkerModule();
  const runId = 'RUN-H2';
  const checkerEpisodeId = '002-deep-review';
  const sourceClaimSha256 = 'c'.repeat(64);
  const cases = [
    ['manifest-json', { manifest: Buffer.from('caller-authored manifest bytes') }],
    ['manifest-name', { manifest: Buffer.from('{"name":"other","version":"2.4.0","skills":"./skills/"}\n') }],
    ['manifest-skills', { manifest: Buffer.from('{"name":"deep-review","version":"2.4.0","skills":"./elsewhere/"}\n') }],
    ['manifest-version', { manifest: Buffer.from('{"name":"deep-review","version":"9.9.9","skills":"./skills/"}\n') }],
    ['skill-frontmatter', { skill: Buffer.from('---\nname: other-review\n---\n# forged\n') }],
    ['skill-utf8', { skill: Buffer.from([0xff, 0xfe, 0xfd]) }],
    ['manifest-topology', { sourceOverrides: { manifest_path: '/trusted/deep-review/elsewhere/plugin.json' } }],
    ['skill-topology', { sourceOverrides: { skill_path: '/trusted/deep-review/skills/other/SKILL.md' } }],
  ];
  for (const [name, options] of cases) {
    const root = canonicalRealpath(mkdtempSync(join(tmpdir(), `dl-retained-${name}-`)));
    const attemptId = `attempt-${name}`;
    const { proof } = writeExactDualCapture({
      root, runId, checkerEpisodeId, attemptId, sourceClaimSha256, ...options,
    });
    assert.throws(() => captureTrustedCheckerSkill({
      root, runId, checkerEpisodeId, attemptId, sourceClaimSha256, proof,
    }), /checker-capture-/, name);
  }

  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-retained-authentic-')));
  const attemptId = 'attempt-authentic';
  const { proof } = writeExactDualCapture({
    root, runId, checkerEpisodeId, attemptId, sourceClaimSha256,
  });
  assert.deepEqual(captureTrustedCheckerSkill({
    root, runId, checkerEpisodeId, attemptId, sourceClaimSha256, proof,
  }), proof);
});
