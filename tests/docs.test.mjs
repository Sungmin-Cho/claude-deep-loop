import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_CMDS = ['/deep-loop', '/deep-loop-discover', '/deep-loop-triage', '/deep-loop-continue',
  '/deep-loop-handoff', '/deep-loop-resume', '/deep-loop-status', '/deep-loop-ack', '/deep-loop-finish'];
const CODEX_SKILL_CMDS = SKILL_CMDS.map(command => `$deep-loop:${command.slice(1)}`);
const USER_DOCS = ['README.md', 'README.ko.md'];
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

test('user docs publish Claude Code, Codex CLI, and Codex App install and invocation tables', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    for (const command of SKILL_CMDS) {
      assert.ok(source.includes(command), `${path} missing Claude invocation ${command}`);
    }
    for (const command of CODEX_SKILL_CMDS) {
      assert.ok(source.includes(command), `${path} missing Codex invocation ${command}`);
    }
    for (const surface of ['Claude Code', 'Codex CLI', 'Codex App']) {
      assert.match(source, new RegExp(`\\|\\s*${surface.replace(' ', '\\s+')}\\s*\\|`, 'i'),
        `${path} missing ${surface} table row`);
    }
    assert.match(source, /\/plugins/);
    assert.match(source, /~\/\.agents\/plugins\/marketplace\.json/);
    assert.match(source, /~\/\.codex\/plugins\/deep-loop/);
    assert.match(source, /~\/\.codex\/plugins\/deep-loop[\s\S]{0,500}~\/\.agents\/plugins\/marketplace\.json[\s\S]{0,220}source\.path[\s\S]{0,120}"\.\/\.codex\/plugins\/deep-loop"/i,
      `${path} must bind the personal plugin directory to its marketplace-relative source.path value`);
    assert.ok(source.includes('/plugin marketplace add Sungmin-Cho/claude-deep-suite'),
      `${path} missing the exact post-sync Claude marketplace command`);
    assert.ok(source.includes('/plugin install deep-loop@claude-deep-suite'),
      `${path} missing the exact post-sync Claude install command`);
    assert.doesNotMatch(source, /\/plugin (?:marketplace add|install)[^\n`]*\.\.\./,
      `${path} must not ship placeholder Claude install commands`);
    assert.match(source, /ChatGPT desktop app[\s\S]{0,180}(?:select|선택)[\s\S]{0,80}Work or Codex[\s\S]{0,160}(?:open|열)[\s\S]{0,80}Plugins/i);
    assert.match(source, /restart (?:the )?App/i);
    assert.match(source, /new (?:task|session)/i);
  }
});

test('Codex App support is in-task only and preserves the honest manual continuation boundary', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /Codex App[\s\S]{0,500}install\/discovery[\s\S]{0,200}in-task (?:skill )?execution/i);
    assert.match(source, /Codex App[\s\S]{0,700}\$deep-loop:deep-loop-resume/i);
    assert.match(source, /Codex App[\s\S]{0,700}(?:manual|수동)/i);
    assert.match(source, /no (?:automated|automatic) app-native task creation/i);
    assert.match(source, /no private app-native task-creation (?:URL|deep link)/i);
    assert.doesNotMatch(source, /no private Codex App (?:URL|deep link)/i);
    assert.match(source, /App smoke pending external evidence/i);
  }
});

test('user docs carry the exact cross-runtime support matrix and distinguish PowerShell from WSL', () => {
  const rows = [
    'Claude Code, macOS/Linux',
    'Claude Code, native Windows',
    'Codex CLI, macOS/Linux',
    'Codex CLI, native Windows',
    'Codex App',
  ];
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    for (const row of rows) assert.ok(source.includes(`| ${row} |`), `${path} missing support row ${row}`);
    assert.match(source, /native Windows[\s\S]{0,500}PowerShell/i);
    assert.match(source, /WSL[\s\S]{0,500}(?:Linux|not native Windows|네이티브 Windows가 아님)/i);
    assert.match(source, /native Windows CI[^\n]*(?:pending external evidence|외부 증거 대기)/i);
    assert.match(source, /App smoke pending external evidence/i);
    assert.ok(source.includes("$env:DEEP_LOOP_UNATTENDED = '1'"),
      `${path} must include the native PowerShell unattended invocation`);
  }
});

test('visible fallback documents the runtime-correct manual resume command for both hosts', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    const marker = path === 'README.md' ? '**OS-agnostic fallback**' : '**OS 무관 폴백**';
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${path} missing visible fallback section`);
    const section = source.slice(start, start + 1400);
    assert.ok(section.includes('/deep-loop-resume'), `${path} fallback missing Claude resume`);
    assert.ok(section.includes('$deep-loop:deep-loop-resume'), `${path} fallback missing Codex resume`);
  }
});

test('user docs define exact-hook trust and durable fallback without granting isolated children plugins', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /exact hook definition/i);
    assert.match(source, /direct shell-free Node/i);
    assert.match(source, /PreCompact[\s\S]{0,300}emit-only[\s\S]{0,300}best-effort/i);
    assert.match(source, /missing or untrusted hook[\s\S]{0,350}durable lease[\s\S]{0,250}pause[\s\S]{0,250}manual resume/i);
    assert.match(source, /isolated Codex child[\s\S]{0,250}(?:disables|disabled)[\s\S]{0,120}plugins[\s\S]{0,120}hooks/i);
  }
});

test('user docs define runtime and launcher executable diagnosis, approval, and drift fencing', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    for (const command of [
      'runtime-executable diagnose',
      'runtime-executable approve',
      'launcher-executable diagnose',
      'launcher-executable approve',
    ]) assert.ok(source.includes(command), `${path} missing ${command}`);
    assert.match(source, /runtime-executable approve --runtime <claude\|codex> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>"/);
    assert.match(source, /launcher-executable approve --kind <wt\|powershell> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>"/);
    for (const token of ['canonical_path', 'sha256', '--actor human', '--confirm', '--owner', '--generation']) {
      assert.ok(source.includes(token), `${path} missing approval token ${token}`);
    }
    assert.match(source, /canonical absolute path/i);
    assert.match(source, /lowercase SHA-256/i);
    assert.match(source, /identity drift[\s\S]{0,250}fail(?:s)? closed[\s\S]{0,180}pause/i);
    assert.match(source, /runtime\/launcher Authenticode signer policy[\s\S]{0,300}pending Windows observation/i);
    assert.match(source, /distinct from[\s\S]{0,180}Claude Desktop handler pin/i);
    assert.match(source, /no bare PATH/i);
    assert.match(source, /no[^\n]*(?:shim|\.cmd|\.ps1)[^\n]*authority/i);
    assert.match(source, /no bare `?wt\.exe`? authority/i);
  }
});

test('proposal-only scope includes repository, release, deletion, and registry synchronization actions', () => {
  for (const path of USER_DOCS) {
    const source = readFileSync(join(R, path), 'utf8');
    for (const action of ['push', 'PR', 'merge', 'publish', 'delete']) {
      assert.match(source, new RegExp(`proposal-only[^\\n]{0,240}\\b${action}\\b`, 'i'),
        `${path} must include ${action} in proposal-only scope`);
    }
    assert.match(source, /proposal-only[^\n]{0,300}(?:marketplace|deep-suite)[^\n]{0,120}sync/i);
  }
});

test('maintainer guides use portable test discovery and the current compatibility design without fixed module counts', () => {
  for (const path of ['CLAUDE.md', 'AGENTS.md']) {
    const source = readFileSync(join(R, path), 'utf8');
    assert.match(source, /node --test/);
    assert.doesNotMatch(source, /node --test tests\/\*\.test\.mjs/,
      `${path} must not document shell-expanded test discovery`);
    assert.ok(source.includes('docs/superpowers/specs/2026-07-10-codex-windows-compatibility-design.md'),
      `${path} must link the current compatibility design`);
    assert.doesNotMatch(source, /scripts\/lib\/\*\.mjs`?\s*\(\d+ modules\)/i);
  }
});

test('deep-suite patch declares node-only runtime and current durable artifacts without stale test counts', () => {
  const source = readFileSync(join(R, 'integration/deep-suite.patch.md'), 'utf8');
  assert.match(source, /"runtime":\s*\["node"\]/);
  assert.doesNotMatch(source, /"runtime":\s*\[[^\]]*"bash"/);
  assert.doesNotMatch(source, /\b\d+ tests green\b/i);
  for (const artifact of [
    '.deep-loop/runs/<run-id>/reviews/<sha256>.json',
    '.deep-loop/runs/<run-id>/preflight/cache/<cache-key>.json',
    '.deep-loop/runs/<run-id>/preflight/accounting/<cache-key>.json',
    '.deep-loop/runs/<run-id>/preflight/process-receipts/<receipt>.json',
  ]) assert.ok(source.includes(artifact), `integration patch missing ${artifact}`);
  assert.match(source, /post-merge[\s\S]{0,240}(?:separate approval|별도 승인)/i);
  assert.match(source, /marketplace[\s\S]{0,200}sync[\s\S]{0,200}(?:proposal-only|별도 승인)/i);
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
