import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeAppHost,
  FakeStructuredProcess,
  executePreparedAction,
} from './helpers/fake-app-host.mjs';

test('fake structured process rejects pre-READY writes and records zero echo', () => {
  const process = new FakeStructuredProcess({
    readyToken: 'DEEP_LOOP_STDIN_READY:v1:app-confirm:ATTEMPT:pipe-open-noecho',
    result: { ok: true },
  });
  assert.throws(() => process.writeLine('THREAD\n'), /WRITE_BEFORE_READY/);
  assert.equal(process.start(), 'DEEP_LOOP_STDIN_READY:v1:app-confirm:ATTEMPT:pipe-open-noecho');
  assert.deepEqual(process.writeLine('THREAD\n'), { ok: true });
  assert.deepEqual(process.transcript, [
    'DEEP_LOOP_STDIN_READY:v1:app-confirm:ATTEMPT:pipe-open-noecho',
    '{"ok":true}',
  ]);
  assert.deepEqual(process.echoedInputs, []);
  assert.throws(() => process.writeLine('SECOND\n'), /STRUCTURED_INPUT_ALREADY_CONSUMED/);

  const bounded = new FakeStructuredProcess({ readyToken: 'READY', result: { ok: true },
    maxBytes: 6 });
  assert.equal(bounded.start(), 'READY');
  assert.throws(() => bounded.writeLine('1234567\n'), /STRUCTURED_LINE_TOO_LARGE/);
  assert.throws(() => bounded.writeLine('123456\n'), /STRUCTURED_INPUT_ALREADY_CONSUMED/);
  const boundary = new FakeStructuredProcess({ readyToken: 'READY', result: { ok: true },
    maxBytes: 6 });
  assert.equal(boundary.start(), 'READY');
  assert.deepEqual(boundary.writeLine('123456\n'), { ok: true });
});

test('fake host executes only reviewed create or fork public actions', async () => {
  const createHost = new FakeAppHost({ createReceipt: { threadId: 'CREATE-ID' } });
  assert.deepEqual(await executePreparedAction({
    tool: 'create_thread', target: { type: 'project', projectId: 'PROJECT', environment: { type: 'local' } },
    prompt: 'PROMPT',
  }, createHost), { threadId: 'CREATE-ID' });
  assert.deepEqual(createHost.calls.map(call => call.tool), ['create_thread']);

  const forkHost = new FakeAppHost({ forkReceipt: { threadId: 'FORK-ID' }, sendReceipt: {} });
  assert.deepEqual(await executePreparedAction({
    tool: 'fork_thread', environment: { type: 'same-directory' },
    followup: { tool: 'send_message_to_thread', prompt: 'PROMPT' },
  }, forkHost), { threadId: 'FORK-ID' });
  assert.deepEqual(forkHost.calls.map(call => call.tool), ['fork_thread', 'send_message_to_thread']);
  assert.equal(JSON.stringify(forkHost.calls).includes('model'), false);
  assert.equal(JSON.stringify(forkHost.calls).includes('thinking'), false);
});
