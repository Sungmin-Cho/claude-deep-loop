import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createDirectoryJunction,
  createFileSymlinkOrSkip,
} from './helpers/fs-fixtures.mjs';

const PROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DETECTOR = join(PROOT, 'scripts', 'lib', 'detect-main.mjs');
const HOOKS = [
  join(PROOT, 'scripts', 'hooks-impl', 'precompact-handoff.mjs'),
  join(PROOT, 'scripts', 'hooks-impl', 'drive-headless.mjs'),
];

async function loadDetector() {
  assert.equal(existsSync(DETECTOR), true, 'scripts/lib/detect-main.mjs must exist');
  const module = await import(pathToFileURL(DETECTOR).href);
  assert.equal(typeof module.detectMain, 'function');
  return module.detectMain;
}

function writeDetectorEntrypoint(directory) {
  mkdirSync(directory, { recursive: true });
  const entrypoint = join(directory, 'entrypoint.mjs');
  writeFileSync(entrypoint, [
    `import { detectMain } from ${JSON.stringify(pathToFileURL(DETECTOR).href)};`,
    'const result = detectMain(import.meta.url, process.argv[1]);',
    "if (result.diagnostic) process.stderr.write(`${result.diagnostic}\\n`);",
    "if (result.isMain) process.stdout.write('main\\n');",
    '',
  ].join('\n'));
  return entrypoint;
}

function assertRunsMainOnce(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trim().split('\n').filter(Boolean), ['main']);
}

test('detectMain runs a direct entrypoint under a plugin path containing spaces exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'deep loop plugin '));
  const entrypoint = writeDetectorEntrypoint(join(root, 'plugin root with spaces'));
  assertRunsMainOnce(spawnSync(process.execPath, [entrypoint], { encoding: 'utf8' }));
});

test('detectMain canonicalizes a symlinked directory and runs exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-main-link-'));
  const realDirectory = join(root, 'real-plugin');
  writeDetectorEntrypoint(realDirectory);
  const linkedDirectory = join(root, 'linked plugin');
  createDirectoryJunction(realDirectory, linkedDirectory);
  assertRunsMainOnce(spawnSync(process.execPath, [join(linkedDirectory, 'entrypoint.mjs')], { encoding: 'utf8' }));
});

test('detectMain canonicalizes a symlinked entrypoint and runs exactly once', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dl-main-file-link-'));
  const entrypoint = writeDetectorEntrypoint(join(root, 'real-plugin'));
  const linkedEntrypoint = join(root, 'linked-entrypoint.mjs');
  if (!createFileSymlinkOrSkip(t, entrypoint, linkedEntrypoint)) return;
  assertRunsMainOnce(spawnSync(process.execPath, [linkedEntrypoint], { encoding: 'utf8' }));
});

test('detectMain honors --preserve-symlinks-main and runs a symlinked main exactly once', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dl-main-preserve-'));
  const entrypoint = writeDetectorEntrypoint(join(root, 'real'));
  const linkedEntrypoint = join(root, 'preserved-main.mjs');
  if (!createFileSymlinkOrSkip(t, entrypoint, linkedEntrypoint)) return;
  assertRunsMainOnce(spawnSync(process.execPath, ['--preserve-symlinks-main', linkedEntrypoint], { encoding: 'utf8' }));
});

test('detectMain treats import mismatch and missing, non-string, or empty argv as normal non-main use', async () => {
  const detectMain = await loadDetector();
  const root = mkdtempSync(join(tmpdir(), 'dl-main-import-'));
  const modulePath = join(root, 'module.mjs');
  const otherPath = join(root, 'other.mjs');
  writeFileSync(modulePath, '');
  writeFileSync(otherPath, '');

  assert.deepEqual(detectMain(pathToFileURL(modulePath).href, otherPath), { isMain: false, diagnostic: null });
  for (const argvPath of [undefined, null, 0, {}, '']) {
    assert.deepEqual(detectMain(pathToFileURL(modulePath).href, argvPath), { isMain: false, diagnostic: null });
  }
});

test('detectMain returns stable path-free diagnostics for every canonicalization failure with no lexical fallback', async () => {
  const detectMain = await loadDetector();
  const argvPath = join(tmpdir(), 'same', 'path.mjs');
  const moduleUrl = pathToFileURL(argvPath).href;
  const cases = [
    ['https://example.invalid/main.mjs', argvPath, {}, 'DEEP_LOOP_MAIN_NON_FILE_URL'],
    [moduleUrl, argvPath, { fileURLToPath: () => { throw new Error('/secret/file-url'); } }, 'DEEP_LOOP_MAIN_FILE_URL_FAILED'],
    [moduleUrl, argvPath, { resolve: () => { throw new Error('/secret/resolve'); } }, 'DEEP_LOOP_MAIN_RESOLVE_FAILED'],
    [moduleUrl, argvPath, { realpathSync: () => { throw new Error('/secret/realpath'); } }, 'DEEP_LOOP_MAIN_REALPATH_FAILED'],
    [moduleUrl, argvPath, {
      realpathSync: (value) => value,
      pathToFileURL: () => { throw new Error('/secret/path-url'); },
    }, 'DEEP_LOOP_MAIN_PATH_URL_FAILED'],
  ];

  for (const [url, argv, deps, expectedDiagnostic] of cases) {
    const result = detectMain(url, argv, deps);
    assert.deepEqual(result, { isMain: false, diagnostic: expectedDiagnostic });
    assert.match(result.diagnostic, /^[A-Z][A-Z0-9_]{0,63}$/);
    assert.doesNotMatch(result.diagnostic, /same|secret|path\.mjs/i);
  }
});

test('detectMain prefers realpathSync.native and compares canonical file URL hrefs', async () => {
  const detectMain = await loadDetector();
  let fallbackCalls = 0;
  let nativeCalls = 0;
  const realpathSync = () => { fallbackCalls += 1; return '/fallback'; };
  realpathSync.native = (value) => { nativeCalls += 1; return value; };
  const result = detectMain('file:///canonical/main.mjs', '/canonical/main.mjs', {
    fileURLToPath: () => '/canonical/main.mjs',
    resolve: (value) => value,
    realpathSync,
    pathToFileURL: (value) => new URL(`file://${value}`),
  });
  assert.deepEqual(result, { isMain: true, diagnostic: null });
  assert.equal(nativeCalls, 2);
  assert.equal(fallbackCalls, 0);
});

test('both hook modules export main and route direct-entry detection through the shared detector', async () => {
  for (const hook of HOOKS) {
    const source = readFileSync(hook, 'utf8');
    assert.match(source, /from ['"]\.\.\/lib\/detect-main\.mjs['"]/);
    assert.match(source, /detectMain\(import\.meta\.url,\s*process\.argv\[1\]\)/);
    assert.doesNotMatch(source, /`file:\/\/\$\{/);
    const module = await import(pathToFileURL(hook).href);
    assert.equal(typeof module.main, 'function', `${hook} must export main`);
  }
});

test('hook detection diagnostics go to stderr and never execute either main', () => {
  for (const hook of HOOKS) {
    const code = `process.argv[1]='\\0';await import(${JSON.stringify(pathToFileURL(hook).href)})`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'DEEP_LOOP_MAIN_REALPATH_FAILED\n');
  }
});
