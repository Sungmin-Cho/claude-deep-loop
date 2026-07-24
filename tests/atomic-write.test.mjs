import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const atomicApiPromise = import('../scripts/lib/atomic-write.mjs').catch(() => ({}));
const envelopeApiPromise = import('../scripts/lib/envelope.mjs');

async function atomicApi() {
  const api = await atomicApiPromise;
  assert.equal(typeof api.renameAtomicWithRetry, 'function', 'renameAtomicWithRetry must be exported');
  assert.equal(typeof api.atomicWrite, 'function', 'atomicWrite must be exported');
  assert.equal(typeof api.durableAtomicWrite, 'function', 'durableAtomicWrite must be exported');
  return api;
}

function sharingError(code) {
  return Object.assign(new Error(`sharing failure: ${code}`), { code });
}

test('rename retry window is pinned to one second and envelope re-exports the shared helpers', async () => {
  const api = await atomicApi();
  const envelope = await envelopeApiPromise;
  assert.equal(api.RENAME_RETRY_MAX_ELAPSED_MS, 1_000);
  assert.equal(envelope.renameAtomicWithRetry, api.renameAtomicWithRetry);
  assert.equal(envelope.atomicWrite, api.atomicWrite);
});

for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
  test(`Windows transient ${code} retries the identical rename syscall until success`, async () => {
    const { renameAtomicWithRetry } = await atomicApi();
    const calls = [];
    const sleeps = [];
    let now = 0;
    renameAtomicWithRetry('same-src', 'same-dst', {
      platform: 'win32',
      monotonicNowFn: () => now,
      sleepFn: (ms) => { sleeps.push(ms); now += ms; },
      renameFn: (src, dst) => {
        calls.push([src, dst]);
        if (calls.length < 3) throw sharingError(code);
      },
    });
    assert.deepEqual(calls, [
      ['same-src', 'same-dst'],
      ['same-src', 'same-dst'],
      ['same-src', 'same-dst'],
    ]);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps.every(ms => ms === sleeps[0] && ms > 0), 'backoff must be fixed and positive');
  });
}

test('non-sharing errors fail immediately without sleeping', async () => {
  const { renameAtomicWithRetry } = await atomicApi();
  const expected = sharingError('EIO');
  let attempts = 0;
  let sleeps = 0;
  assert.throws(() => renameAtomicWithRetry('src', 'dst', {
    platform: 'win32',
    monotonicNowFn: () => 0,
    sleepFn: () => { sleeps++; },
    renameFn: () => { attempts++; throw expected; },
  }), error => error === expected);
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test('transient sharing errors do not retry off Windows', async () => {
  const { renameAtomicWithRetry } = await atomicApi();
  const expected = sharingError('EACCES');
  let attempts = 0;
  let sleeps = 0;
  assert.throws(() => renameAtomicWithRetry('src', 'dst', {
    platform: 'linux',
    monotonicNowFn: () => 0,
    sleepFn: () => { sleeps++; },
    renameFn: () => { attempts++; throw expected; },
  }), error => error === expected);
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test('retry exhaustion starts no attempt or sleep at or across the monotonic deadline', async () => {
  const { renameAtomicWithRetry, RENAME_RETRY_MAX_ELAPSED_MS } = await atomicApi();
  const expected = sharingError('EBUSY');
  const attemptTimes = [];
  const sleeps = [];
  let now = 0;
  assert.throws(() => renameAtomicWithRetry('src', 'dst', {
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn: (ms) => { sleeps.push({ start: now, ms }); now += ms; },
    renameFn: () => { attemptTimes.push(now); throw expected; },
  }), error => error === expected);
  assert.ok(attemptTimes.length > 1, 'an allowlisted Windows error must retry');
  assert.ok(attemptTimes.every(at => at < RENAME_RETRY_MAX_ELAPSED_MS));
  assert.ok(sleeps.every(({ start, ms }) => start < RENAME_RETRY_MAX_ELAPSED_MS
    && start + ms < RENAME_RETRY_MAX_ELAPSED_MS));
  assert.equal(attemptTimes.length, sleeps.length + 1);
});

test('a fresh immediately-pre-retry clock check fences a deadline crossed after sleep', async () => {
  const { renameAtomicWithRetry } = await atomicApi();
  const expected = sharingError('EACCES');
  const clock = [0, 0, 999, 1_000];
  let clockReads = 0;
  let attempts = 0;
  let sleeps = 0;
  assert.throws(() => renameAtomicWithRetry('src', 'dst', {
    platform: 'win32',
    monotonicNowFn: () => clock[clockReads++],
    sleepFn: () => { sleeps++; },
    renameFn: () => { attempts++; throw expected; },
  }), error => error === expected);
  assert.equal(attempts, 1, 'no retry may begin when the fresh clock reaches the deadline');
  assert.equal(sleeps, 1);
  assert.equal(clockReads, 4, 'deadline must be sampled again immediately before retry');
});

test('atomicWrite writes one temp payload and retries only its rename', async () => {
  const { atomicWrite } = await atomicApi();
  const writes = [];
  const renames = [];
  const sleeps = [];
  let now = 0;
  atomicWrite('/virtual/final.json', 'payload', {
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn: (ms) => { sleeps.push(ms); now += ms; },
    writeFn: (path, contents) => { writes.push([path, contents]); },
    renameFn: (src, dst) => {
      renames.push([src, dst]);
      if (renames.length < 3) throw sharingError('EPERM');
    },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], 'payload');
  assert.equal(renames.length, 3);
  assert.ok(renames.every(([src, dst]) => src === writes[0][0] && dst === '/virtual/final.json'));
  assert.equal(sleeps.length, 2);
});

test('atomicWrite repeatedly replaces an existing destination', async () => {
  const { atomicWrite } = await atomicApi();
  const root = mkdtempSync(join(tmpdir(), 'dl-atomic-replace-'));
  const path = join(root, 'artifact.json');
  atomicWrite(path, 'first');
  atomicWrite(path, 'second');
  assert.equal(readFileSync(path, 'utf8'), 'second');
});

test('durableAtomicWrite orders write, file fsync, rename, then parent-directory fsync', async () => {
  const { durableAtomicWrite } = await atomicApi();
  const calls = [];
  let nextFd = 10;
  const fdKinds = new Map();
  durableAtomicWrite('/virtual/parent/final.bin', Buffer.from('bytes'), {
    platform: 'linux',
    tempPathFactory: () => '/virtual/parent/temp.bin',
    writeFn(path, bytes, options) { calls.push(['write', path, Buffer.from(bytes).toString(), options]); },
    openFn(path, mode) {
      assert.equal(mode, 'r');
      const fd = nextFd++;
      fdKinds.set(fd, path);
      calls.push(['open', path]);
      return fd;
    },
    fsyncFn(fd) { calls.push(['fsync', fdKinds.get(fd)]); },
    closeFn(fd) { calls.push(['close', fdKinds.get(fd)]); },
    renameFn(src, dst) { calls.push(['rename', src, dst]); },
  });
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [
    ['write', '/virtual/parent/temp.bin', 'bytes'],
    ['open', '/virtual/parent/temp.bin'],
    ['fsync', '/virtual/parent/temp.bin'],
    ['close', '/virtual/parent/temp.bin'],
    ['rename', '/virtual/parent/temp.bin', '/virtual/parent/final.bin'],
    ['open', '/virtual/parent'],
    ['fsync', '/virtual/parent'],
    ['close', '/virtual/parent'],
  ]);
});

test('durableAtomicWrite uses a writable Windows temp-file handle and a read-only directory handle', async () => {
  const { durableAtomicWrite } = await atomicApi();
  const opens = [];
  durableAtomicWrite('/virtual/parent/final.bin', Buffer.from('bytes'), {
    platform: 'win32',
    tempPathFactory: () => '/virtual/parent/temp.bin',
    writeFn() {},
    openFn(path, mode) {
      opens.push([path, mode]);
      if (path === '/virtual/parent/temp.bin') {
        if (mode === 'r') throw Object.assign(new Error('Windows fsync requires a writable file handle'), { code: 'EPERM' });
        assert.equal(mode, 'r+');
        return 10;
      }
      assert.equal(path, '/virtual/parent');
      assert.equal(mode, 'r');
      return 11;
    },
    fsyncFn() {},
    closeFn() {},
    renameFn() {},
  });
  assert.deepEqual(opens, [
    ['/virtual/parent/temp.bin', 'r+'],
    ['/virtual/parent', 'r'],
  ]);
});

test('durableAtomicWrite exposes exact post-operation crash barriers', async () => {
  const { durableAtomicWrite } = await atomicApi();
  const barriers = [];
  let nextFd = 30;
  durableAtomicWrite('/virtual/parent/final.bin', Buffer.from('bytes'), {
    tempPathFactory: () => '/virtual/parent/temp.bin',
    writeFn() {},
    openFn: () => nextFd++,
    fsyncFn() {},
    closeFn() {},
    renameFn() {},
    barrierAt(label) { barriers.push(label); },
  });
  assert.deepEqual(barriers, ['write', 'file-flush', 'rename', 'parent-flush']);
});

test('durableAtomicWrite tolerates only documented Windows directory capability errors', async () => {
  const { durableAtomicWrite } = await atomicApi();
  for (const code of ['EINVAL', 'ENOTSUP', 'ENOSYS', 'EISDIR']) {
    assert.doesNotThrow(() => durableAtomicWrite('/virtual/final.bin', 'x', {
      platform: 'win32', tempPathFactory: () => '/virtual/temp.bin', writeFn() {},
      openFn(path) {
        if (path === '/virtual') throw Object.assign(new Error(code), { code });
        return 1;
      },
      fsyncFn() {}, closeFn() {}, renameFn() {},
    }));
  }
  assert.throws(() => durableAtomicWrite('/virtual/final.bin', 'x', {
    platform: 'win32', tempPathFactory: () => '/virtual/temp.bin', writeFn() {},
    openFn(path) {
      if (path === '/virtual') throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return 1;
    },
    fsyncFn() {}, closeFn() {}, renameFn() {},
  }), /EIO/);

  assert.throws(() => durableAtomicWrite('/virtual/final.bin', 'x', {
    platform: 'linux', tempPathFactory: () => '/virtual/temp.bin', writeFn() {},
    openFn(path) {
      if (path === '/virtual') throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      return 1;
    },
    fsyncFn() {}, closeFn() {}, renameFn() {},
  }), /EINVAL/);
});

test('durableAtomicWrite never suppresses a file fsync failure', async () => {
  const { durableAtomicWrite } = await atomicApi();
  let renamed = false;
  let closed = false;
  assert.throws(() => durableAtomicWrite('/virtual/final.bin', 'x', {
    platform: 'win32', tempPathFactory: () => '/virtual/temp.bin', writeFn() {},
    openFn: () => 7,
    fsyncFn() { throw Object.assign(new Error('file-fsync'), { code: 'EINVAL' }); },
    closeFn() { closed = true; },
    renameFn() { renamed = true; },
    unlinkFn() {},
  }), /file-fsync/);
  assert.equal(closed, true);
  assert.equal(renamed, false);
});
