import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_CMDS = ['/deep-loop', '/deep-loop-discover', '/deep-loop-triage', '/deep-loop-continue',
  '/deep-loop-handoff', '/deep-loop-resume', '/deep-loop-status', '/deep-loop-ack', '/deep-loop-finish'];
const LIVE_SURFACE_DOCS = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'hooks/hooks.json'];

test('README lists all commands + architecture + safety', () => {
  const s = readFileSync(join(R, 'README.md'), 'utf8');
  for (const c of SKILL_CMDS) assert.ok(s.includes(c), `README missing ${c}`);
  assert.match(s, /2-plane|control plane/i);
  assert.match(s, /proposal-only|human approval|사람 승인/i);
  assert.match(s, /standalone|독립/i);
});

test('README.ko mirrors commands', () => {
  const s = readFileSync(join(R, 'README.ko.md'), 'utf8');
  for (const c of SKILL_CMDS) assert.ok(s.includes(c), `README.ko missing ${c}`);
});

test('live-surface docs name the shell-free PreCompact implementation and never the deleted Bash wrapper', () => {
  const staleWrapperReferences = [];
  const missingImplementationReferences = [];
  for (const path of LIVE_SURFACE_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    if (source.includes('hooks/scripts/precompact-handoff.sh')) staleWrapperReferences.push(path);
    const namesImplementation = path === 'hooks/hooks.json'
      ? source.includes("'scripts','hooks-impl','precompact-handoff.mjs'")
      : source.includes('scripts/hooks-impl/precompact-handoff.mjs');
    if (!namesImplementation) missingImplementationReferences.push(path);
  }
  assert.deepEqual({ staleWrapperReferences, missingImplementationReferences }, {
    staleWrapperReferences: [],
    missingImplementationReferences: [],
  });
});

test('PreCompact manifest is emit-only and assigns unattended continuation to the measured driver', () => {
  const manifest = JSON.parse(readFileSync(join(R, 'hooks/hooks.json'), 'utf8'));
  assert.match(manifest.description, /\bemit-only\b/i);
  assert.match(manifest.description, /unattended continuation is deferred to the measured driveHeadless driver/i);
  assert.doesNotMatch(manifest.description, /\b(?:headless\s+)?respawn\b/i);
});

test('CHANGELOG has a 0.1.0 entry', () => {
  assert.ok(existsSync(join(R, 'CHANGELOG.md')));
  assert.match(readFileSync(join(R, 'CHANGELOG.md'), 'utf8'), /0\.1\.0|v1/);
});
