import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DRIVER = fileURLToPath(new URL('./fixtures/standalone-isolation-driver.mjs', import.meta.url));
const CONSUMER = fileURLToPath(new URL('./fixtures/orca-descriptor-consumer.mjs', import.meta.url));

function run(runtime) {
  const result = spawnSync(process.execPath, [DRIVER, runtime], {
    encoding: 'utf8',
    env: { PATH: '', TMPDIR: process.env.TMPDIR ?? '' },
    maxBuffer: 2_097_152,
  });
  assert.equal(result.status, 0, `${runtime}: ${result.stderr}`);
  return { bytes: result.stdout, value: JSON.parse(result.stdout) };
}

test('standalone isolation completes for claude and codex without Orca or siblings', () => {
  const source = readFileSync(DRIVER, 'utf8');
  assert.match(source, /PATH:\s*''/);
  assert.match(source, /'adapter',\s*'resolve'/,
    'the isolated lifecycle must resolve the production maker descriptor');
  assert.match(source, /dispatch\.kind\s*!==\s*'inline'/,
    'the isolated lifecycle must consume the standalone inline descriptor');
  assert.match(source, /cwd:\s*project/,
    'every public CLI call must execute from the isolated project cwd');
  assert.match(source, /HOME:\s*isolatedHome/,
    'plugin discovery must use an isolated home rather than the real user home');
  assert.match(source, /isolatedHome\s*=\s*mkdtempSync\(join\(tmpdir\(\)/,
    'the isolated user state must remain outside the project and kernel tree');
  assert.match(source, /LOCALAPPDATA:\s*join\(isolatedHome,\s*['"]\.localappdata['"]\)/,
    'Windows stored activation state must use the same isolated user root');
  assert.match(source, /XDG_STATE_HOME:\s*join\(isolatedHome,\s*['"]\.state['"]\)/,
    'stored activation secrets must use the isolated fixture user state');
  assert.match(source, /'lease',\s*'acquire'[\s\S]*?'--attempt-id'[\s\S]*?'lease',\s*'activate',\s*'--stored-token'/,
    'boundary recovery must acquire and then activate with one durable attempt');
  assert.match(source, /Object\.entries\(detected\)[\s\S]{0,300}\.present/,
    'the fixture must report the detector result instead of replacing keyed output with an empty list');
  assert.doesNotMatch(source, /ORCA_PANE_KEY|orca-loop|mcp__|claude\s+-p|codex\s+exec|deep-(?:work|review|wiki|memory)/i,
    'the isolated lifecycle may use only this plugin CLI');
  for (const runtime of ['claude', 'codex']) {
    const { value } = run(runtime);
    assert.equal(value.runtime, runtime);
    assert.equal(value.protocol, 'standalone');
    assert.equal(value.orca_present, false);
    assert.deepEqual(value.detected_plugins, []);
    assert.equal(value.terminal_escape, 'human-confirmed-abandon-without-independent-checker');
    assert.deepEqual(value.stages, [
      'init', 'dispatch-inline', 'prepare', 'observe', 'restore', 'continue', 'status', 'ack',
      'terminal-boundary', 'handoff', 'resume', 'recovery', 'activation', 'finish',
    ]);
    assert.equal(value.terminal_status, 'stopped');
    assert.equal(value.descriptor.action.type, 'handoff');
    assert.equal(value.descriptor.action.reason, 'workstream-terminal');
    assert.match(value.descriptor.boundary_identity, /^[1-9]\d*:[0-9a-f]{64}$/);
  }
});

test('positive Orca consumer preserves descriptor bytes and semantic fields', () => {
  const source = readFileSync(CONSUMER, 'utf8');
  assert.doesNotMatch(source, /deep-loop\.mjs|child_process|execFile|spawn/,
    'the consumer may not call back into deep-loop or launch an Orca executable');
  for (const runtime of ['claude', 'codex']) {
    const produced = run(runtime);
    const descriptorBytes = `${JSON.stringify(produced.value.descriptor)}\n`;
    const consumed = spawnSync(process.execPath, [CONSUMER], {
      input: descriptorBytes,
      encoding: 'utf8',
      env: { ORCA_PANE_KEY: 'positive-fixture-only', PATH: '' },
    });
    assert.equal(consumed.status, 0, consumed.stderr);
    assert.equal(consumed.stdout, descriptorBytes);
    assert.deepEqual(JSON.parse(consumed.stdout), produced.value.descriptor);
  }
});
