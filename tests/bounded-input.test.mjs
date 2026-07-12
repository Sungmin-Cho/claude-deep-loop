import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  REVIEW_IMPORT_MAX_BYTES,
  readBoundedText,
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
