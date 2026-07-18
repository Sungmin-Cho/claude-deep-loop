import {
  existsSync, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync,
  readdirSync, readlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileSymlink, createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';
import {
  createFileDurablyIfAbsent,
  renamePreparedFile,
} from '../scripts/lib/durable-file.mjs';

test('durable helper syncs a POSIX parent after same-directory rename', () => {
  const calls = [];
  const regular = { dev: 1, ino: 2, isFile: () => true, isSymbolicLink: () => false };
  let sourcePresent = true;
  let destinationPresent = false;
  const missing = path => Object.assign(new Error(path), { code: 'ENOENT' });
  renamePreparedFile('/run/.tmp-a', '/run/loop.json', {}, {
    platform: 'linux',
    lstat: path => {
      if (path === '/run/.tmp-a' && sourcePresent
          || path === '/run/loop.json' && destinationPresent) return regular;
      throw missing(path);
    },
    readFile: path => {
      if (path === '/run/.tmp-a' && sourcePresent
          || path === '/run/loop.json' && destinationPresent) return 'source';
      throw missing(path);
    },
    open: path => (calls.push(['open', path]), path),
    fstat: () => regular,
    fsync: fd => calls.push(['fsync', fd]), close: fd => calls.push(['close', fd]),
    rename: (from, to) => {
      calls.push(['rename', from, to]);
      sourcePresent = false;
      destinationPresent = true;
    },
    monotonicNowFn: () => 0, sleepFn: () => assert.fail('POSIX rename is not retried'),
  });
  assert.deepEqual(calls.filter(call => call[0] === 'rename'),
    [['rename', '/run/.tmp-a', '/run/loop.json']]);
  assert.deepEqual(calls.at(-3), ['open', '/run']);
  assert.deepEqual(calls.at(-2), ['fsync', '/run']);
});

test('durable helper never opens a Windows directory fd and retries sharing errors boundedly', () => {
  const regular = { dev: 1, ino: 2, isFile: () => true, isSymbolicLink: () => false };
  let attempts = 0;
  let sourcePresent = true;
  let destinationPresent = false;
  const opens = [];
  const clock = [0, 0, 50, 50, 100, 100];
  const source = 'C:\\run\\.tmp-a';
  const destination = 'C:\\run\\loop.json';
  const missing = path => Object.assign(new Error(path), { code: 'ENOENT' });
  renamePreparedFile('C:\\run\\.tmp-a', 'C:\\run\\loop.json', {}, {
    platform: 'win32',
    lstat: path => {
      if (path === source && sourcePresent || path === destination && destinationPresent) {
        return regular;
      }
      throw missing(path);
    },
    readFile: path => {
      if (path === source && sourcePresent || path === destination && destinationPresent) {
        return 'source';
      }
      throw missing(path);
    },
    open: (path, flags) => {
      assert.notEqual(path, 'C:\\run', 'Windows must not open a directory for fsync');
      opens.push([path, flags]);
      return path;
    }, fstat: () => regular, fsync: () => {}, close: () => {},
    rename: () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('sharing'), { code: 'EPERM' });
      sourcePresent = false;
      destinationPresent = true;
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

test('rename preserves a dangling or live destination symlink installed after validation', context => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'dl-durable-symlink-probe-'));
  const probeTarget = join(probeRoot, 'target');
  const probeLink = join(probeRoot, 'link');
  writeFileSync(probeTarget, 'probe');
  if (!createFileSymlinkOrSkip(context, probeTarget, probeLink)) return;
  unlinkSync(probeLink);
  for (const kind of ['dangling', 'live']) {
    const root = mkdtempSync(join(tmpdir(), `dl-durable-destination-${kind}-`));
    const source = join(root, '.tmp-source');
    const destination = join(root, 'loop.json');
    const linkTarget = join(root, kind === 'live' ? 'live-target' : 'missing-target');
    writeFileSync(source, 'prepared-source');
    if (kind === 'live') writeFileSync(linkTarget, 'live-target-bytes');
    let installed = false;
    const lstat = path => {
      try { return lstatSync(path); }
      catch (error) {
        if (path === destination && error?.code === 'ENOENT' && !installed) {
          installed = true;
          createFileSymlink(linkTarget, destination);
        }
        throw error;
      }
    };

    assert.throws(() => renamePreparedFile(source, destination, {}, { lstat }),
      /DURABLE_DESTINATION_INVALID/);
    assert.equal(lstatSync(destination).isSymbolicLink(), true);
    assert.equal(readlinkSync(destination), linkTarget);
    assert.equal(readFileSync(source, 'utf8'), 'prepared-source');
  }
});

test('create-if-absent preserves a foreign regular that replaces its owned temporary', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-durable-owned-temp-'));
  const target = join(root, 'request.md');
  const temporary = `${target}.create-callerownednonce0`;
  const foreign = Buffer.from('kernel skeleton');
  let replaced = false;

  assert.throws(() => createFileDurablyIfAbsent(target, 'kernel skeleton', {
    nonce: () => 'callerownednonce0',
  }, {
    durableOpen: (path, flags, mode) => openSync(path, flags, mode),
    durableFstat: descriptor => {
      const stat = fstatSync(descriptor);
      if (!replaced) {
        replaced = true;
        unlinkSync(temporary);
        writeFileSync(temporary, foreign, { flag: 'wx' });
      }
      return stat;
    },
    durableWriteDescriptor: (descriptor, bytes) => writeFileSync(descriptor, bytes),
  }), /DURABLE_(?:SOURCE|OWNERSHIP)_CHANGED/);
  assert.equal(existsSync(target), false, 'a replaced staging pathname is never published');
  assert.deepEqual(readFileSync(temporary), foreign,
    'inode identity prevents adoption or cleanup of a same-bytes ABA replacement');
});

test('rename refuses publication when the source changes during file sync', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-durable-source-sync-'));
  const source = join(root, '.tmp-source');
  const destination = join(root, 'loop.json');
  writeFileSync(source, 'prepared-source');
  let changed = false;
  const mutateDuringSync = () => {
    if (changed) return;
    changed = true;
    writeFileSync(source, 'changed-during-sync');
  };

  assert.throws(() => renamePreparedFile(source, destination, {}, {
    fsync: mutateDuringSync,
    durableFsync: mutateDuringSync,
  }), /DURABLE_SOURCE_CHANGED/);
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(source, 'utf8'), 'changed-during-sync');
});
