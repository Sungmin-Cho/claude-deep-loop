#!/usr/bin/env node
// Portable unit-lane runner. `node --test tests/unit` is a single module on
// Node 26, and a quoted recursive glob is not a positional test path on Node 20.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const unitDir = process.env.DEEP_LOOP_UNIT_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'unit');
let names;
try {
  names = readdirSync(unitDir);
} catch (error) {
  console.error(`test:unit: cannot read ${unitDir}: ${error.message}`);
  process.exit(1);
}
const files = names
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => join(unitDir, name))
  .sort();
if (files.length === 0) {
  console.error('test:unit: no tests/unit/*.test.mjs files found');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) console.error(result.error);
process.exit(result.status === null ? 1 : result.status);
