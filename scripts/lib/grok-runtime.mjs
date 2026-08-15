import { posix, win32 } from 'node:path';
import { buildGrokHeadlessArgv } from './checker-launch.mjs';

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function absolute(value, code) {
  if (typeof value !== 'string' || value.length === 0
    || (!posix.isAbsolute(value) && !win32.isAbsolute(value))) {
    throw Object.assign(new Error(`${code}: absolute path required`), { code });
  }
  return value;
}

export function buildGrokHeadlessEntry({
  executable,
  projectRoot,
  prompt,
  schema,
  model = 'grok-4.6',
  effort = 'xhigh',
  env = {},
} = {}) {
  const bin = absolute(executable, 'INVALID_GROK_EXECUTABLE');
  const cwd = absolute(projectRoot, 'INVALID_GROK_PROJECT_ROOT');
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('INVALID_GROK_PROMPT');
  }
  if (!SAFE_MODEL.test(model || '')) throw new Error('INVALID_GROK_MODEL');
  if (!EFFORTS.has(effort)) throw new Error('INVALID_GROK_EFFORT');
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('INVALID_GROK_SCHEMA');
  }
  const encodedSchema = JSON.stringify(schema);
  if (Buffer.byteLength(encodedSchema, 'utf8') > 512 * 1024) {
    throw new Error('INVALID_GROK_SCHEMA');
  }
  if (env == null || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('INVALID_GROK_ENV');
  }
  return {
    bin,
    argv: buildGrokHeadlessArgv({
      projectRoot: cwd,
      model,
      effort,
      schemaJson: encodedSchema,
      prompt,
    }),
    cwd,
    env: { ...env },
    shell: false,
    usageOutputKind: 'grok-json',
    captureFinalMessage: true,
    captureProcessDiagnostic: true,
    trustedModelId: model,
  };
}
