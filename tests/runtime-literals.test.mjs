import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATTERN = /(?:[!=]==\s*'(?:claude|codex)'|\['claude',\s*'codex'\])/;
const ALLOWLIST = join(repoRoot, 'schemas/runtime-literal-allowlist.json');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('every runtime literal in scripts/ is converted or declared', () => {
  const allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const declared = new Set(allowlist.entries.map(e => `${e.file}:${e.line}`));
  const undeclared = [];

  for (const file of walk(join(repoRoot, 'scripts'))) {
    const rel = relative(repoRoot, file);
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (!PATTERN.test(line)) return;
      const key = `${rel}:${index + 1}`;
      if (!declared.has(key)) undeclared.push(`${key}  ${line.trim()}`);
    });
  }

  assert.deepEqual(undeclared, [],
    'Undeclared runtime literals. Convert them to runtimeCapability(...) or add an '
    + 'entry with a reason to schemas/runtime-literal-allowlist.json:\n' + undeclared.join('\n'));
});

test('every allowlist entry still points at a matching line', () => {
  const allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  for (const entry of allowlist.entries) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0,
      `${entry.file}:${entry.line} needs a reason`);
    const lines = readFileSync(join(repoRoot, entry.file), 'utf8').split('\n');
    const actual = lines[entry.line - 1] ?? '';
    assert.ok(PATTERN.test(actual),
      `${entry.file}:${entry.line} no longer contains a runtime literal — the allowlist is stale`);
    assert.ok(actual.includes(entry.literal.split('&&')[0].trim()),
      `${entry.file}:${entry.line} no longer matches the declared literal ${entry.literal}`);
  }
});
