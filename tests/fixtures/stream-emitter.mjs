import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';

const [mode, ...args] = process.argv.slice(2);
const usage = JSON.stringify({
  num_turns: 1,
  usage: { input_tokens: 7, output_tokens: 5 },
});

const chunks = [];
if (mode === 'close-stdin-valid') {
  process.stdin.destroy();
  process.stdout.write(usage);
  await new Promise((resolve) => setTimeout(resolve, 50));
} else {
  for await (const chunk of process.stdin) chunks.push(chunk);
}

const input = Buffer.concat(chunks).toString('utf8');

if (mode === 'close-stdin-valid') {
  // Handled before consuming stdin so the parent observes a real EPIPE/write failure.
} else if (mode === 'checkpoint') {
  const [expectedCwd] = args;
  if (input !== 'streaming checkpoint') process.exit(65);
  if (realpathSync(process.cwd()) !== realpathSync(expectedCwd)) process.exit(66);
  if (process.env.STREAM_TOKEN !== 'explicit-only') process.exit(67);
  if (process.env.SHOULD_NOT_LEAK != null) process.exit(68);
  process.stdout.write(usage);
} else if (mode === 'nonzero-valid') {
  process.stdout.write(usage);
  process.exitCode = 7;
} else if (mode === 'timeout-valid') {
  process.stdout.write(usage);
  setInterval(() => {}, 10_000);
} else if (mode === 'ignore-term') {
  const [pidPath] = args;
  writeFileSync(pidPath, String(process.pid));
  process.on('SIGTERM', () => {});
  process.stdout.write(usage);
  setInterval(() => {}, 10_000);
} else if (mode === 'large-stderr') {
  const chunk = Buffer.alloc(32 * 1024, 0x65);
  for (let i = 0; i < 128; i += 1) {
    if (!process.stderr.write(chunk)) await once(process.stderr, 'drain');
  }
  process.stdout.write(usage);
} else if (mode === 'invalid-stderr') {
  const chunk = Buffer.alloc(32 * 1024, 0xff);
  for (let i = 0; i < 4; i += 1) {
    if (!process.stderr.write(chunk)) await once(process.stderr, 'drain');
  }
  process.stdout.write(usage);
} else if (mode === 'codex-stream') {
  const events = [
    `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })}\r\n`,
    `${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(2 * 1024 * 1024) } })}\n`,
    `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 4, output_tokens: 13, reasoning_output_tokens: 3 } })}\n`,
  ];
  for (const event of events) {
    const buffer = Buffer.from(event);
    for (let offset = 0; offset < buffer.length; offset += 31 * 1024) {
      if (!process.stdout.write(buffer.subarray(offset, offset + 31 * 1024))) {
        await once(process.stdout, 'drain');
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
} else if (mode === 'count-once') {
  const [counterPath] = args;
  appendFileSync(counterPath, 'spawned\n');
  if (input !== 'worker-only stdin') process.exit(69);
  process.stdout.write(usage);
} else {
  process.exit(64);
}
