import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'preflight.yml');
const workflowExists = existsSync(WORKFLOW_PATH);
const source = workflowExists ? readFileSync(WORKFLOW_PATH, 'utf8') : '';
const lines = source.split(/\r?\n/);
const requiresWorkflow = { skip: !workflowExists };

function indentation(line) {
  return line.match(/^ */)[0].length;
}

function mappingBlock(key, indent = 0) {
  const header = `${' '.repeat(indent)}${key}:`;
  const starts = lines.flatMap((line, index) => line === header ? [index] : []);
  assert.deepEqual(starts.length, 1, `${header} must occur exactly once`);

  let end = starts[0] + 1;
  while (end < lines.length) {
    if (lines[end].trim() !== '' && indentation(lines[end]) <= indent) break;
    end += 1;
  }
  return lines.slice(starts[0] + 1, end);
}

function directMappingKeys(block, indent) {
  const pattern = new RegExp(`^ {${indent}}([^\\s:#][^:]*):(?:\\s.*)?$`);
  return block.flatMap((line) => {
    const match = line.match(pattern);
    return match ? [match[1].trim()] : [];
  });
}

function scalarOccurrences(key) {
  const pattern = new RegExp(`^\\s*${key.replaceAll('-', '\\-')}:\\s*(.+?)\\s*$`);
  return lines.flatMap((line) => {
    const match = line.match(pattern);
    return match ? [match[1]] : [];
  });
}

function inlineMatrixValues(key) {
  const matrix = mappingBlock('matrix', 6);
  const pattern = new RegExp(`^ {8}${key}:\\s*\\[([^\\]]*)\\]\\s*$`);
  const matches = matrix.flatMap((line) => {
    const match = line.match(pattern);
    return match ? [match[1]] : [];
  });
  assert.equal(matches.length, 1, `matrix.${key} must be one inline list`);
  return matches[0].split(',').map((value) => value.trim().replace(/^['"]|['"]$/g, ''));
}

test('cross-platform preflight workflow exists', () => {
  assert.equal(workflowExists, true, 'missing .github/workflows/preflight.yml');
});

test('workflow has only the requested triggers and top-level read-only contents permission', requiresWorkflow, () => {
  assert.deepEqual(directMappingKeys(mappingBlock('on'), 2), [
    'push',
    'pull_request',
    'workflow_dispatch',
  ]);
  assert.deepEqual(directMappingKeys(mappingBlock('permissions'), 2), ['contents']);
  assert.deepEqual(scalarOccurrences('contents'), ['read']);
  assert.equal(lines.filter((line) => line.trim() === 'permissions:').length, 1,
    'permissions must be declared once at the top level');
});

test('strategy keeps all cells running across the exact 3 by 3 OS and Node matrix', requiresWorkflow, () => {
  assert.deepEqual(scalarOccurrences('fail-fast'), ['false']);

  const matrix = mappingBlock('matrix', 6);
  assert.deepEqual(directMappingKeys(matrix, 8), ['os', 'node'],
    'matrix must not add include, exclude, or another axis');
  const operatingSystems = inlineMatrixValues('os');
  const nodeVersions = inlineMatrixValues('node');
  assert.deepEqual(operatingSystems, ['ubuntu-latest', 'macos-latest', 'windows-latest']);
  assert.deepEqual(nodeVersions, ['20', '22', '24']);
  assert.equal(new Set(operatingSystems).size * new Set(nodeVersions).size, 9,
    'the matrix must expand to exactly nine unique jobs');
});

test('one matrix job binds the runner and setup-node version to their axes', requiresWorkflow, () => {
  assert.deepEqual(directMappingKeys(mappingBlock('jobs'), 2), ['preflight']);
  assert.deepEqual(scalarOccurrences('runs-on'), ['${{ matrix.os }}']);
  assert.deepEqual(scalarOccurrences('node-version'), ['${{ matrix.node }}']);
});

test('workflow pins exactly checkout v4 and setup-node v4', requiresWorkflow, () => {
  const actions = lines.flatMap((line) => {
    const match = line.match(/^\s*-\s+uses:\s*(\S+)\s*$/);
    return match ? [match[1]] : [];
  });
  assert.deepEqual(actions, ['actions/checkout@v4', 'actions/setup-node@v4']);
});

test('all nine jobs run the same shell-neutral preflight command without dependency installation or cache', requiresWorkflow, () => {
  assert.deepEqual(scalarOccurrences('run'), ['npm run preflight']);
  assert.deepEqual(scalarOccurrences('shell'), [], 'the workflow must not select an OS-specific shell');
  assert.deepEqual(scalarOccurrences('cache'), [], 'zero-dependency CI must not configure a dependency cache');
  assert.doesNotMatch(source, /\bnpm\s+(?:ci|install)\b/i);
  assert.doesNotMatch(source, /(?:package-lock|npm-shrinkwrap|yarn\.lock|pnpm-lock)/i);
  assert.doesNotMatch(source, /(?:^|\s)(?:bash|sh|pwsh|powershell)(?:\s|$)/im);
});
