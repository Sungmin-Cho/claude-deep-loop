import {
  linkSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFileDurablyIfAbsent,
  renamePreparedFile,
} from '../scripts/lib/durable-file.mjs';

test('durable helper syncs a POSIX parent after same-directory rename', () => {
  const calls = [];
  const regular = { isFile: () => true, isSymbolicLink: () => false };
  renamePreparedFile('/run/.tmp-a', '/run/loop.json', {}, {
    platform: 'linux', lstat: () => regular,
    open: path => (calls.push(['open', path]), path),
    fsync: fd => calls.push(['fsync', fd]), close: fd => calls.push(['close', fd]),
    rename: (from, to) => calls.push(['rename', from, to]),
    monotonicNowFn: () => 0, sleepFn: () => assert.fail('POSIX rename is not retried'),
  });
  assert.deepEqual(calls.filter(call => call[0] === 'rename'),
    [['rename', '/run/.tmp-a', '/run/loop.json']]);
  assert.deepEqual(calls.at(-3), ['open', '/run']);
  assert.deepEqual(calls.at(-2), ['fsync', '/run']);
});

test('durable helper never opens a Windows directory fd and retries sharing errors boundedly', () => {
  const regular = { isFile: () => true, isSymbolicLink: () => false };
  let attempts = 0;
  const opens = [];
  const clock = [0, 0, 50, 50, 100, 100];
  renamePreparedFile('C:\\run\\.tmp-a', 'C:\\run\\loop.json', {}, {
    platform: 'win32', lstat: () => regular,
    open: (path, flags) => {
      assert.notEqual(path, 'C:\\run', 'Windows must not open a directory for fsync');
      opens.push([path, flags]);
      return path;
    }, fsync: () => {}, close: () => {},
    rename: () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('sharing'), { code: 'EPERM' });
    }, monotonicNowFn: () => clock.shift() ?? 100, sleepFn: () => {},
  });
  assert.equal(attempts, 3);
  assert.deepEqual(opens, [['C:\\run\\.tmp-a', 'r+']],
    'Windows FlushFileBuffers requires a write-capable, non-truncating handle');
});

test('durable create-if-absent never replaces a check-to-publish race winner', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-durable-no-replace-'));
  const target = join(root, 'request.md');
  const created = createFileDurablyIfAbsent(target, 'kernel skeleton', {
    nonce: () => 'callerownednonce0',
  }, {
    link: (source, destination) => {
      writeFileSync(destination, 'execution-plane winner');
      return linkSync(source, destination);
    },
  });
  assert.equal(created, false);
  assert.equal(readFileSync(target, 'utf8'), 'execution-plane winner');
  assert.deepEqual(readdirSync(root), ['request.md'],
    'the losing caller cleans only its own temporary');
});
