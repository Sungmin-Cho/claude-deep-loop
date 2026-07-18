import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import {
  APP_STDIN_READ_TIMEOUT_MS,
  REVIEW_IMPORT_MAX_BYTES,
  readBoundedText,
  readStructuredLine,
  structuredReadyToken,
} from '../scripts/lib/bounded-input.mjs';

test('review import byte limit is pinned to 1 MiB', () => {
  assert.equal(REVIEW_IMPORT_MAX_BYTES, 1_048_576);
});

test('readBoundedText decodes one fatal UTF-8 document across split code points', async () => {
  const euro = Buffer.from('A€Z');
  const stream = Readable.from([euro.subarray(0, 2), euro.subarray(2, 3), euro.subarray(3)]);
  assert.equal(await readBoundedText(stream), 'A€Z');
});

test('readBoundedText accepts the exact raw-byte bound and rejects one byte over', async () => {
  assert.equal(await readBoundedText(Readable.from([Buffer.alloc(8, 0x61)]), { maxBytes: 8 }), 'aaaaaaaa');
  await assert.rejects(
    readBoundedText(Readable.from([Buffer.alloc(4), Buffer.alloc(5)]), { maxBytes: 8 }),
    /REVIEW_IMPORT_TOO_LARGE/,
  );
});

test('readBoundedText rejects malformed and truncated UTF-8 after retaining raw Buffer chunks', async () => {
  await assert.rejects(readBoundedText(Readable.from([Buffer.from([0xc3, 0x28])])), /REVIEW_IMPORT_UTF8_INVALID/);
  await assert.rejects(readBoundedText(Readable.from([Buffer.from([0xe2, 0x82])])), /REVIEW_IMPORT_UTF8_INVALID/);
});

test('readBoundedText validates its byte bound and stream contract', async () => {
  await assert.rejects(readBoundedText(Readable.from([]), { maxBytes: 0 }), /REVIEW_IMPORT_BOUND_INVALID/);
  await assert.rejects(readBoundedText(null), /REVIEW_IMPORT_STREAM_INVALID/);
});

test('pty reader enters raw mode before READY and restores it after one line', async () => {
  const calls = [];
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = value => calls.push(['raw', value]);
  const promise = readStructuredLine(stream, {
    mode: 'pty-raw-noecho', purpose: 'confirm', binding: 'attempt-1', maxBytes: 513,
    writeReady: token => calls.push(['ready', token]),
  });
  stream.end(Buffer.from('opaque $`\\ id\n'));
  assert.equal(await promise, 'opaque $`\\ id');
  assert.deepEqual(calls, [
    ['raw', true],
    ['ready', 'DEEP_LOOP_STDIN_READY:v1:confirm:attempt-1:pty-raw-noecho'],
    ['raw', false],
  ]);
});

test('pipe reader installs listeners before READY, accepts a split one-line record, and cleans up', async () => {
  const stream = new PassThrough();
  const calls = [];
  const promise = readStructuredLine(stream, {
    mode: 'pipe-open-noecho', purpose: 'probe', binding: 'nonce-1', maxBytes: 32,
    writeReady: token => {
      for (const event of ['data', 'end', 'close', 'error']) {
        assert.ok(stream.listenerCount(event) > 0, event + ' listener missing before READY');
      }
      calls.push(['ready', token]);
    },
    setTimeoutFn: (fn, ms) => { assert.equal(ms, APP_STDIN_READ_TIMEOUT_MS); return 9; },
    clearTimeoutFn: id => calls.push(['clear', id]),
  });
  stream.write('opaque');
  stream.end('\n');
  assert.equal(await promise, 'opaque');
  assert.deepEqual(calls, [
    ['ready', 'DEEP_LOOP_STDIN_READY:v1:probe:nonce-1:pipe-open-noecho'], ['clear', 9],
  ]);
  for (const event of ['data', 'end', 'close', 'error']) assert.equal(stream.listenerCount(event), 0);
});

test('pipe reader accepts synchronous post-READY input from the READY writer', async () => {
  const stream = new PassThrough();
  let readyCalls = 0;
  const promise = readStructuredLine(stream, {
    mode: 'pipe-open-noecho', purpose: 'probe', binding: 'nonce-sync', maxBytes: 32,
    writeReady: token => {
      readyCalls += 1;
      assert.equal(token, 'DEEP_LOOP_STDIN_READY:v1:probe:nonce-sync:pipe-open-noecho');
      stream.end('synchronous\n');
    },
  });
  assert.equal(await promise, 'synchronous');
  assert.equal(readyCalls, 1);
});

test('READY token rejects invalid purpose, binding, mode, control, and size', () => {
  for (const input of [
    { purpose: 'bad:purpose', binding: 'ok', mode: 'pipe-open-noecho' },
    { purpose: 'probe', binding: '', mode: 'pipe-open-noecho' },
    { purpose: 'probe', binding: 'bad\nvalue', mode: 'pipe-open-noecho' },
    { purpose: 'probe', binding: 'x'.repeat(513), mode: 'pipe-open-noecho' },
    { purpose: 'probe', binding: 'ok', mode: 'tty' },
  ]) assert.throws(() => structuredReadyToken(input), /STRUCTURED_STDIN_BINDING_INVALID/);
});

test('ended or aborted pipe never emits READY', async () => {
  const ended = Readable.from([]);
  for await (const _chunk of ended) { /* drain to readableEnded */ }
  let ready = 0;
  await assert.rejects(readStructuredLine(ended, { mode: 'pipe-open-noecho', purpose: 'probe',
    binding: 'nonce-1', writeReady: () => { ready += 1; } }), /STRUCTURED_STDIN_PIPE_CLOSED/);
  const aborted = new PassThrough();
  Object.defineProperty(aborted, 'readableAborted', { value: true });
  await assert.rejects(readStructuredLine(aborted, { mode: 'pipe-open-noecho', purpose: 'probe',
    binding: 'nonce-2', writeReady: () => { ready += 1; } }), /STRUCTURED_STDIN_PIPE_CLOSED/);
  assert.equal(ready, 0);
});

test('pipe mode rejects a TTY before READY instead of accepting an echoing channel', async () => {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => assert.fail('pipe mode never toggles TTY raw mode');
  let ready = 0;
  await assert.rejects(readStructuredLine(stream, { mode: 'pipe-open-noecho', purpose: 'probe',
    binding: 'nonce-tty', writeReady: () => { ready += 1; } }),
  /STRUCTURED_STDIN_PIPE_TTY/);
  assert.equal(ready, 0);
});

test('bytes delivered before READY are rejected and READY is not emitted', async () => {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = value => { if (value) stream.write('early\n'); };
  let ready = 0;
  await assert.rejects(readStructuredLine(stream, { mode: 'pty-raw-noecho', purpose: 'probe',
    binding: 'nonce-3', writeReady: () => { ready += 1; } }), /STRUCTURED_STDIN_EARLY_WRITE/);
  assert.equal(ready, 0);
});

function rawStream({ restoreThrows = false } = {}) {
  const calls = [];
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = value => {
    calls.push(value);
    if (!value && restoreThrows) throw new Error('restore failed');
  };
  return { stream, calls };
}

test('structured reader rejects malformed UTF-8 and restores raw mode', async () => {
  const { stream, calls } = rawStream();
  const pending = readStructuredLine(stream, { mode: 'pty-raw-noecho', purpose: 'confirm',
    binding: 'attempt-1', maxBytes: 8, writeReady: () => {} });
  stream.end(Buffer.from([0xc3, 0x28, 0x0a]));
  await assert.rejects(pending, /STRUCTURED_STDIN_UTF8_INVALID/);
  assert.deepEqual(calls, [true, false]);
});

test('structured reader rejects split extra records, oversize, timeout, and restore failure', async () => {
  const extra = rawStream();
  const extraPending = readStructuredLine(extra.stream, { mode: 'pty-raw-noecho', purpose: 'confirm',
    binding: 'attempt-1', maxBytes: 8, writeReady: () => {} });
  extra.stream.write('a\n');
  extra.stream.end('b\n');
  await assert.rejects(extraPending, /STRUCTURED_STDIN_MULTILINE/);

  const delayed = rawStream();
  const delayedPending = readStructuredLine(delayed.stream, { mode: 'pty-raw-noecho', purpose: 'confirm',
    binding: 'attempt-delayed', maxBytes: 8, writeReady: () => {} });
  delayed.stream.write('a\n');
  await new Promise(resolve => setImmediate(() => {
    delayed.stream.end('b\n');
    resolve();
  }));
  await assert.rejects(delayedPending, /STRUCTURED_STDIN_MULTILINE/);

  const large = rawStream();
  const largePending = readStructuredLine(large.stream, { mode: 'pty-raw-noecho', purpose: 'confirm',
    binding: 'attempt-1', maxBytes: 4, writeReady: () => {} });
  large.stream.end('12345\n');
  await assert.rejects(largePending, /STRUCTURED_STDIN_TOO_LARGE/);

  const timeout = rawStream();
  const timeoutPending = readStructuredLine(timeout.stream, { mode: 'pty-raw-noecho', purpose: 'confirm',
    binding: 'attempt-1', writeReady: () => {},
    setTimeoutFn: (fn, ms) => { assert.equal(ms, APP_STDIN_READ_TIMEOUT_MS); queueMicrotask(fn); return 7; },
    clearTimeoutFn: id => assert.equal(id, 7) });
  await assert.rejects(timeoutPending, /STRUCTURED_STDIN_TIMEOUT/);

  const restore = rawStream({ restoreThrows: true });
  const restorePending = readStructuredLine(restore.stream, { mode: 'pty-raw-noecho', purpose: 'confirm',
    binding: 'attempt-1', writeReady: () => {} });
  restore.stream.end('ok\n');
  await assert.rejects(restorePending, /STRUCTURED_STDIN_RAW_RESTORE_FAILED/);

  const readyFailure = rawStream();
  await assert.rejects(readStructuredLine(readyFailure.stream, { mode: 'pty-raw-noecho', purpose: 'confirm',
    binding: 'attempt-1', writeReady: () => { throw new Error('ready failed'); } }), /ready failed/);
  assert.deepEqual(readyFailure.calls, [true, false]);
});

test('structured reader normalizes raw setup and stream lifecycle failures and removes listeners', async () => {
  const missing = new PassThrough(); missing.isTTY = true;
  await assert.rejects(readStructuredLine(missing, { mode: 'pty-raw-noecho', purpose: 'confirm',
    binding: 'attempt-1', writeReady: () => {} }), /STRUCTURED_STDIN_RAW_UNAVAILABLE/);
  const throwing = new PassThrough(); throwing.isTTY = true;
  throwing.setRawMode = () => { throw new Error('raw failed'); };
  await assert.rejects(readStructuredLine(throwing, { mode: 'pty-raw-noecho', purpose: 'confirm',
    binding: 'attempt-1', writeReady: () => {} }), /raw failed/);
  for (const event of ['end', 'close', 'error']) {
    const fixture = rawStream();
    const pending = readStructuredLine(fixture.stream, { mode: 'pty-raw-noecho', purpose: 'confirm',
      binding: `attempt-${event}`, writeReady: () => {} });
    if (event === 'error') fixture.stream.emit('error', new Error('stream failed'));
    else fixture.stream.emit(event);
    await assert.rejects(pending, /STRUCTURED_STDIN_(?:ERROR|EARLY_EOF|CLOSED)/);
    for (const name of ['data', 'end', 'close', 'error']) assert.equal(fixture.stream.listenerCount(name), 0);
  }
});
