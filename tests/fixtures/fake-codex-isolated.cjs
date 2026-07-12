const {
  appendFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const WRITE_PROBE_PREFIX = 'DEEP_LOOP_CODEX_WRITE_PROBE=';
const LARGE_ITEM_BYTES = 16 * 1024 * 1024;
const LARGE_STDERR_BYTES = 4 * 1024 * 1024;

function readStdin() {
  return readFileSync(0, 'utf8');
}

function writeRepeated(fd, byte, count) {
  const chunk = Buffer.alloc(64 * 1024, byte);
  let remaining = count;
  while (remaining > 0) {
    const width = Math.min(remaining, chunk.length);
    writeSync(fd, chunk, 0, width);
    remaining -= width;
  }
}

function classify(prompt) {
  if (prompt.includes(WRITE_PROBE_PREFIX)) return 'preflight-write';
  if (prompt.includes('Run exactly one single independent read-only review pass.')) return 'checker';
  if (prompt.includes('Complete one terminal JSONL turn without writing files')) return 'preflight-read';
  return 'maker';
}

function requiredIsolationPresent(argv) {
  const adjacent = (left, right) => argv.some((value, index) => value === left && argv[index + 1] === right);
  return argv.includes('--ephemeral')
    && argv.includes('--json')
    && argv.includes('--strict-config')
    && argv.includes('--ignore-user-config')
    && argv.includes('--ignore-rules')
    && adjacent('--disable', 'apps')
    && adjacent('--disable', 'plugins')
    && adjacent('--disable', 'browser_use')
    && adjacent('--disable', 'browser_use_external')
    && adjacent('--disable', 'computer_use')
    && adjacent('--disable', 'image_generation')
    && adjacent('--disable', 'in_app_browser')
    && argv.includes('approval_policy="never"')
    && argv.includes('web_search="disabled"')
    && argv.includes('sandbox_workspace_write.network_access=false')
    && argv.includes('features.skill_mcp_dependency_install=false')
    && argv.includes('shell_environment_policy.inherit="core"')
    && !argv.some(value => value.startsWith('projects.'));
}

function parseWriteProbe(prompt) {
  const line = prompt.split(/\r?\n/).find(value => value.startsWith(WRITE_PROBE_PREFIX));
  return line == null ? null : JSON.parse(line.slice(WRITE_PROBE_PREFIX.length));
}

function emitTerminal(inputTokens, outputTokens) {
  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  })}\n`);
}

function emitLargeMakerItem() {
  writeSync(1, Buffer.from('{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"'));
  writeRepeated(1, 'x', LARGE_ITEM_BYTES);
  writeSync(1, Buffer.from('","exit_code":0}}\n'));
}

function main() {
  try { unlinkSync(__filename); } catch { /* the parent asserts the write probe remains exact */ }

  const prompt = readStdin();
  const kind = classify(prompt);
  const control = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'isolation-control.json'), 'utf8'));
  const argv = process.argv.slice(2);
  const envKeys = Object.keys(process.env).sort();
  appendFileSync(control.invocationLog, `${JSON.stringify({
    kind,
    argv,
    cwd: process.cwd(),
    env_keys: envKeys,
    owner: process.env.DEEP_LOOP_OWNER,
    generation: process.env.DEEP_LOOP_GENERATION,
  })}\n`);

  const forbiddenEnv = envKeys.some(key => key === 'OPENAI_API_KEY' || key === 'DEEP_LOOP_TEST_SECRET'
    || key.startsWith('CLAUDE_') || key.startsWith('MCP_'));
  if (!requiredIsolationPresent(argv) || forbiddenEnv) {
    mkdirSync(control.markerDir, { recursive: true });
    for (const capability of ['hook', 'mcp', 'apps', 'web', 'network', 'dependency-install', 'browser', 'computer', 'image']) {
      writeFileSync(join(control.markerDir, capability), 'activated');
    }
  }

  if (kind === 'preflight-write') {
    const probe = parseWriteProbe(prompt);
    writeFileSync(join(probe.workspace, probe.sentinel), probe.nonce);
    emitTerminal(5, 7);
    return;
  }
  if (kind === 'preflight-read') {
    emitTerminal(2, 3);
    return;
  }
  if (kind === 'maker') {
    if (control.makerMode === 'timeout') {
      emitTerminal(31, 37);
      setInterval(() => {}, 1_000);
      return;
    }
    if (control.makerMode === 'nonzero') {
      emitTerminal(31, 37);
      process.exitCode = 7;
      return;
    }
    if (control.makerMode === 'malformed') {
      process.stdout.write('{"type":"turn.completed"\n');
      return;
    }
    if (control.makerMode === 'no-acquire') {
      emitTerminal(11, 13);
      return;
    }
    emitLargeMakerItem();
    writeRepeated(2, 'e', LARGE_STDERR_BYTES);
    const expectedGeneration = String(Number(process.env.DEEP_LOOP_GENERATION) - 1);
    const acquired = spawnSync(process.execPath, [
      control.kernelPath,
      'lease', 'acquire',
      '--project-root', process.env.DEEP_LOOP_PROJECT_ROOT,
      '--run-id', process.env.DEEP_LOOP_RUN_ID,
      '--owner', process.env.DEEP_LOOP_OWNER,
      '--expect-generation', expectedGeneration,
      '--runtime', 'codex',
    ], {
      cwd: process.env.DEEP_LOOP_PROJECT_ROOT,
      env: process.env,
      encoding: 'utf8',
      shell: false,
    });
    if (acquired.status !== 0) {
      process.stderr.write(`lease-acquire-failed:${acquired.status}:${acquired.stderr}`);
      process.exitCode = 9;
      return;
    }
    emitTerminal(11, 13);
    return;
  }

  if (kind === 'checker') {
    const prefix = 'Immutable review contract: ';
    const contractLine = prompt.split(/\r?\n/).find(line => line.startsWith(prefix));
    const contract = JSON.parse(contractLine.slice(prefix.length));
    const raw = Buffer.from(JSON.stringify({
      schema_version: contract.schema_version,
      reviewer_id: contract.reviewer_id,
      checker_episode_id: contract.checker_episode_id,
      target_maker: contract.target_maker,
      attempt_id: contract.attempt_id,
      verdict: 'APPROVE',
      report_body: 'APPROVE — hostile isolated checker transport verified.',
      artifacts: contract.artifacts,
    }));
    if (control.checkerRawPath) writeFileSync(control.checkerRawPath, raw);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: raw.toString('utf8') },
    })}\n`);
    emitTerminal(17, 19);
    return;
  }

  throw new Error(`unsupported fake Codex invocation: ${kind}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(String(error?.stack || error));
  process.exitCode = 10;
}
