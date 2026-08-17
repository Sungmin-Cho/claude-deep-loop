import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_REVIEW,
  ROUTE_FLAGS,
  allowedNames,
  suggestFlag,
  vocabulary,
} from '../scripts/lib/route-flags.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_KEYS = Object.freeze([
  'path resolve', 'validate', 'detect-plugins', 'recipe-match',
  'run list', 'run resolve',
  'root diagnose', 'root rebind', 'root recover', 'root recovery acquire',
  'runtime-executable diagnose', 'runtime-executable approve',
  'launcher-executable diagnose', 'launcher-executable approve',
  'init-run', 'next-action', 'resume-command', 'tick',
  'checkpoint emit', 'checkpoint inspect', 'checkpoint observe', 'checkpoint restore',
  'lease check', 'lease acquire', 'lease release',
  'workstream new', 'workstream set', 'workstream terminal',
  'episode new', 'episode record', 'episode abandon',
  'review configure', 'review dispatch', 'review record', 'review import',
  'handoff emit', 'respawn', 'state get', 'state patch',
  'pause', 'recover', 'recovery acquire', 'adapter resolve',
  'budget check', 'budget record', 'budget extend',
  'comprehension status', 'comprehension ack',
  'breaker check', 'breaker reset',
  'insights', 'insights latest', 'insights emit',
  'spawn-style probe-desktop', 'spawn-style offer-desktop', 'spawn-style confirm-desktop',
  'spawn-style decline-desktop', 'spawn-style reset-desktop',
  'attended-launch approve', 'attended-launch revoke',
  'session-profile set', 'detect-terminal', 'finish',
]);

function invoke(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('ROUTE_FLAGS lists every rawRouteKey the dispatcher can produce', () => {
  assert.deepEqual(Object.keys(ROUTE_FLAGS).sort(), [...EXPECTED_KEYS].sort());
  assert.equal(EXPECTED_KEYS.length, 63);
});

test('unknown flags are usage exit 2 and do not treat verbs as flags', () => {
  const typo = invoke(['episode', 'record', '--generatoin', '1', '--id', 'e1', '--status', 'done', '--run-id', 'RUN']);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown flag --generatoin for route `episode record`/);
  assert.match(typo.stderr, /did you mean: --generation/);
  assert.match(typo.stderr, /--project-root/);
  assert.match(typo.stderr, /--run-id/);
  assert.match(typo.stderr, /--now/);

  const verb = invoke(['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'plan', '--point', 'plan']);
  assert.notEqual(verb.stderr.includes('unknown flag: new'), true);
  assert.notEqual(verb.stderr.includes('unknown episode verb: --plugin'), true);

  const missing = invoke(['episode', 'not-a-verb', '--plugin', 'x']);
  assert.equal(missing.status, 2);
});

test('did you mean fires only for a unique distance-2 candidate', () => {
  assert.equal(suggestFlag('generatoin', ['generation', 'owner']), 'generation');
  assert.equal(suggestFlag('id', ['episode', 'owner']), null);
  assert.equal(suggestFlag('abc', ['abd', 'adc']), null);
});

function seededReviewArgs() {
  const root = mkdtempSync(join(tmpdir(), 'dl-flag-review-'));
  const created = invoke(['init-run', '--runtime', 'claude', '--goal', 'g', '--protocol', 'standalone', '--project-root', root]);
  assert.equal(created.status, 0, created.stderr);
  const runId = JSON.parse(created.stdout).run_id;
  return { root, runId };
}

for (const route of ['review record', 'review import']) {
  for (const flag of FORBIDDEN_REVIEW) {
    test(`${route} rejects --${flag} with REVIEW_METADATA_FORBIDDEN`, () => {
      const { root, runId } = seededReviewArgs();
      const args = route === 'review import'
        ? ['review', 'import', `--${flag}`, 'x', '--stdin', '--owner', runId, '--generation', '1', '--project-root', root, '--run-id', runId]
        : ['review', 'record', '--episode', 'e', '--verdict', 'APPROVE', `--${flag}`, 'x', '--owner', runId, '--generation', '1', '--project-root', root, '--run-id', runId];
      const result = invoke(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /REVIEW_METADATA_FORBIDDEN/);
    });
  }
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, out);
    else if (entry.isFile() && (entry.name.endsWith('.test.mjs') || entry.name.endsWith('.md'))) out.push(path);
  }
  return out;
}

function routeKeyFromTokens(tokens) {
  const positionals = tokens.filter((token) => token && !token.startsWith('--') && !token.startsWith('<') && !token.startsWith("'"));
  if (positionals.length === 0) return null;
  if (positionals[0] === 'root' && positionals[1] === 'recovery') {
    const key = `root recovery ${positionals[2] || ''}`.trim();
    return Object.hasOwn(ROUTE_FLAGS, key) ? key : null;
  }
  if (positionals[1] && Object.hasOwn(ROUTE_FLAGS, `${positionals[0]} ${positionals[1]}`)) {
    return `${positionals[0]} ${positionals[1]}`;
  }
  return Object.hasOwn(ROUTE_FLAGS, positionals[0]) ? positionals[0] : null;
}

function extractSkillPairs(source) {
  const pairs = [];
  const lineRe = /deep-loop\.mjs"\s+([^\n]+)/g;
  let match;
  while ((match = lineRe.exec(source))) {
    const tokens = match[1].trim().split(/\s+/);
    const key = routeKeyFromTokens(tokens);
    if (!key) continue;
    for (const token of tokens) {
      if (!token.startsWith('--')) continue;
      const flag = token.replace(/^--/, '').replace(/=.*/, '').replace(/[>"'].*$/, '');
      if (flag) pairs.push([key, flag]);
    }
  }
  return pairs;
}

function extractTestPairs(source) {
  const pairs = [];
  const unresolved = [];
  if (/`--\$\{/.test(source) && !/for \(const \[name/.test(source) && !/FORBIDDEN_REVIEW/.test(source)) {
    unresolved.push('unresolved --${} interpolation');
  }
  const arrayRe = /\[((?:'[^']*'|"[^"]*"|\s|,)+)\]/g;
  let match;
  while ((match = arrayRe.exec(source))) {
    const tokens = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
    const key = routeKeyFromTokens(tokens);
    if (!key) continue;
    for (const token of tokens) {
      if (token.startsWith('--')) pairs.push([key, token.slice(2).split('=')[0]]);
    }
  }
  return { pairs, unresolved };
}

test('skill and test (route, flag) pairs are a subset of LOCATOR union allow', () => {
  const allVocab = new Set(Object.values(ROUTE_FLAGS).flatMap((spec) => [...vocabulary(spec)]));
  const missingKeys = [];
  const missingFlags = [];
  const unresolved = [];
  for (const file of walkFiles(join(ROOT, 'skills'))) {
    if (!file.endsWith('.md')) continue;
    for (const [route, flag] of extractSkillPairs(readFileSync(file, 'utf8'))) {
      const spec = ROUTE_FLAGS[route];
      if (!spec) { missingKeys.push(`${file}:${route}`); continue; }
      if (!allowedNames(spec).includes(flag)) missingFlags.push(`${file}:${route} --${flag}`);
    }
  }
  for (const file of walkFiles(join(ROOT, 'tests'))) {
    if (!file.endsWith('.test.mjs')) continue;
    const source = readFileSync(file, 'utf8');
    if (!/deep-loop\.mjs/.test(source) && !/\bCLI\b/.test(source)) continue;
    const extracted = extractTestPairs(source);
    unresolved.push(...extracted.unresolved.map((item) => `${file}:${item}`));
    for (const [route, flag] of extracted.pairs) {
      if (!allVocab.has(flag)) continue;
      const spec = ROUTE_FLAGS[route];
      if (!spec) { missingKeys.push(`${file}:${route}`); continue; }
      if (!allowedNames(spec).includes(flag) && !(spec.rejected || []).includes(flag)) {
        missingFlags.push(`${file}:${route} --${flag}`);
      }
    }
  }
  assert.deepEqual(unresolved, []);
  assert.deepEqual(missingKeys, []);
  assert.deepEqual(missingFlags, []);
});
