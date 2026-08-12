import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { CLI_PATH } from './paths.mjs';
import { assertLexicalRelativePath } from './lexical-path.mjs';
import { evalChildEnv } from './child-env.mjs';

export const EVAL_IO_MAX_BYTES = 64 * 1024;

export function substitutePlaceholders(value, bindings) {
  const map = {
    '<RUN_ID>': bindings.RUN_ID ?? bindings.runId,
    '<ROOT>': bindings.ROOT ?? bindings.root,
    '<PRIOR_OWNER>': bindings.PRIOR_OWNER ?? bindings.priorOwner,
    '<GEN-1>': String((bindings.generation ?? 1) - 1),
  };
  const replace = string => string.replace(/<[^>]+>/g, token => {
    if (!(token in map) || map[token] === undefined) throw new Error(`UNREGISTERED_PLACEHOLDER: ${token}`);
    return String(map[token]);
  });
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map(item => substitutePlaceholders(item, bindings));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitutePlaceholders(item, bindings)]));
  }
  return value;
}

function flatten(value) {
  return Array.isArray(value) ? value.flatMap(flatten) : [String(value)];
}

function fixtureInput(root, fixturePath) {
  assertLexicalRelativePath(fixturePath, 'STDIN_FIXTURE_ESCAPE');
  const base = realpathSync(root);
  const candidate = resolve(base, fixturePath);
  const rel = relative(base, candidate);
  if (rel.startsWith('..') || isAbsolute(rel) || !statSync(candidate).isFile()) throw new Error('STDIN_FIXTURE_ESCAPE');
  return readFileSync(candidate, 'utf8');
}

export function runStep(root, runId, step, bindings = {}, { childEnv = {} } = {}) {
  if (!step || !Array.isArray(step.cmd) || step.cmd.length === 0) throw new Error('STEP_INVALID');
  const bound = { ...bindings, RUN_ID: runId, ROOT: root };
  const command = flatten(substitutePlaceholders(step.cmd, bound));
  let input;
  if (step.stdin?.inline_json !== undefined) input = JSON.stringify(substitutePlaceholders(step.stdin.inline_json, bound));
  else if (step.stdin && Object.hasOwn(step.stdin, 'fixture_path')) {
    input = fixtureInput(root, substitutePlaceholders(step.stdin.fixture_path, bound));
  }
  if (input !== undefined && Buffer.byteLength(input, 'utf8') > EVAL_IO_MAX_BYTES) throw new Error('EVAL_STDIN_TOO_LARGE');

  const directNode = ['node', '-e', '--eval'].includes(command[0]);
  let argv;
  if (directNode) argv = command[0] === 'node' ? command.slice(1) : command;
  else {
    argv = [CLI_PATH, ...command];
    if (!command.includes('--project-root')) argv.push('--project-root', root);
    if (command[0] !== 'init-run' && !command.includes('--run-id')) argv.push('--run-id', runId);
  }
  const result = spawnSync(process.execPath, argv, {
    cwd: root, input, env: evalChildEnv({ ...process.env, ...childEnv }),
    encoding: 'utf8', timeout: 30_000, maxBuffer: EVAL_IO_MAX_BYTES,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || result.error?.message || '');
  if (Buffer.byteLength(stdout, 'utf8') > EVAL_IO_MAX_BYTES || Buffer.byteLength(stderr, 'utf8') > EVAL_IO_MAX_BYTES) {
    throw new Error('EVAL_OUTPUT_TOO_LARGE');
  }
  return {
    exit: typeof result.status === 'number' ? result.status : 1,
    stdout, stderr,
    timedOut: result.error?.code === 'ETIMEDOUT',
    argv: directNode ? [process.execPath, ...argv] : [process.execPath, ...argv],
  };
}

export { CLI_PATH };
