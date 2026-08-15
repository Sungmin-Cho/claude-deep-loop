import { readFileSync } from 'node:fs';
import { dirname, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tomlBasicString } from './toml-safe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REVIEW_SCHEMA_PATH = resolve(here, '..', '..', 'schemas', 'review-import.schema.json');
const REVIEW_SCHEMA_JSON = JSON.stringify(JSON.parse(readFileSync(REVIEW_SCHEMA_PATH, 'utf8')));
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;

function requiredString(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(code);
  }
  return value;
}

function platformAbsolute(value, platform) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return false;
  if (platform === 'win32') {
    return win32.isAbsolute(value) && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value);
  }
  return (platform === 'linux' || platform === 'darwin') && posix.isAbsolute(value);
}

function exactLaunch(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['argv', 'bin', 'cwd', 'shell']);
}

export function buildCodexExecArgv({
  projectRoot,
  model = null,
  effort = null,
  sandbox = 'workspace-write',
  outputSchemaPath = null,
} = {}) {
  const root = requiredString(projectRoot, 'INVALID_CODEX_PROJECT_ROOT');
  if (model !== null) requiredString(model, 'INVALID_CODEX_MODEL');
  if (effort !== null) requiredString(effort, 'INVALID_CODEX_EFFORT');
  if (!['workspace-write', 'read-only'].includes(sandbox)) throw new Error('INVALID_CODEX_SANDBOX');
  if (outputSchemaPath !== null) requiredString(outputSchemaPath, 'INVALID_CODEX_OUTPUT_SCHEMA');
  return [
    'exec', '--ephemeral', '--json', '--strict-config',
    '--ignore-user-config', '--ignore-rules',
    '--disable', 'apps', '--disable', 'plugins',
    '--disable', 'browser_use', '--disable', 'browser_use_external',
    '--disable', 'computer_use', '--disable', 'image_generation',
    '--disable', 'in_app_browser',
    '--sandbox', sandbox,
    ...(model === null ? [] : ['--model', model]),
    ...(effort === null ? [] : ['-c', `model_reasoning_effort=${tomlBasicString(effort)}`]),
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'features.skill_mcp_dependency_install=false',
    '-c', 'shell_environment_policy.inherit="core"',
    ...(outputSchemaPath === null ? [] : ['--output-schema', outputSchemaPath]),
    '-C', root, '-',
  ];
}

export function buildGrokHeadlessArgv({
  projectRoot,
  model,
  effort,
  schemaJson,
  prompt,
} = {}) {
  const root = requiredString(projectRoot, 'INVALID_GROK_PROJECT_ROOT');
  const exactModel = requiredString(model, 'INVALID_GROK_MODEL');
  const exactEffort = requiredString(effort, 'INVALID_GROK_EFFORT');
  const exactSchema = requiredString(schemaJson, 'INVALID_GROK_SCHEMA');
  const exactPrompt = requiredString(prompt, 'INVALID_GROK_PROMPT');
  return [
    '--no-auto-update',
    '--verbatim',
    '--cwd', root,
    '--model', exactModel,
    '--effort', exactEffort,
    '--output-format', 'json',
    '--json-schema', exactSchema,
    '--max-turns', '1',
    '--sandbox', 'read-only',
    '--no-plan',
    '--no-subagents',
    '--no-memory',
    '--disable-web-search',
    '-p', exactPrompt,
  ];
}

export function validDualCheckerLaunch({ launch, executable, attempt, projectRoot } = {}) {
  if (!exactLaunch(launch)
    || executable == null || typeof executable !== 'object' || Array.isArray(executable)
    || attempt == null || typeof attempt !== 'object' || Array.isArray(attempt)
    || launch.bin !== executable.canonical_path
    || launch.cwd !== projectRoot
    || launch.shell !== false
    || !platformAbsolute(launch.bin, executable.platform)
    || !platformAbsolute(launch.cwd, executable.platform)
    || !Array.isArray(launch.argv)) return false;
  if (executable.checker === 'codex') {
    if (!platformAbsolute(REVIEW_SCHEMA_PATH, executable.platform)) return false;
    const expected = buildCodexExecArgv({
      projectRoot,
      model: attempt.model_id,
      effort: 'xhigh',
      sandbox: 'read-only',
      outputSchemaPath: REVIEW_SCHEMA_PATH,
    });
    return JSON.stringify(launch.argv) === JSON.stringify(expected);
  }
  if (executable.checker === 'grok') {
    const prompt = launch.argv.at(-1);
    if (typeof prompt !== 'string' || prompt.length === 0 || prompt.includes('\0')
      || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return false;
    const expected = buildGrokHeadlessArgv({
      projectRoot,
      model: attempt.model_id,
      effort: 'xhigh',
      schemaJson: REVIEW_SCHEMA_JSON,
      prompt,
    });
    return JSON.stringify(launch.argv) === JSON.stringify(expected);
  }
  return false;
}
