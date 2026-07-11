import {
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const WRITE_PROBE_PREFIX = 'DEEP_LOOP_CODEX_WRITE_PROBE=';

export function measuredUsage(inputTokens, outputTokens) {
  return {
    ok: true,
    usage: {
      num_turns: 1,
      tokens: inputTokens + outputTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

export function parseWriteProbePrompt(prompt) {
  const line = String(prompt).split(/\r?\n/)
    .find((candidate) => candidate.startsWith(WRITE_PROBE_PREFIX));
  if (line == null) return null;
  return JSON.parse(line.slice(WRITE_PROBE_PREFIX.length));
}

function materializeWriteProbe(probe, mode, outsideRoot) {
  const sentinel = join(probe.workspace, probe.sentinel);
  switch (mode) {
    case 'exact':
      writeFileSync(sentinel, probe.nonce);
      break;
    case 'missing':
      break;
    case 'wrong':
      writeFileSync(sentinel, `${probe.nonce}-wrong`);
      break;
    case 'extra':
      writeFileSync(sentinel, probe.nonce);
      writeFileSync(join(probe.workspace, 'extra'), 'unexpected');
      break;
    case 'symlink': {
      const outside = join(outsideRoot, 'outside-sentinel');
      writeFileSync(outside, probe.nonce);
      symlinkSync(outside, sentinel, 'file');
      break;
    }
    case 'escape': {
      const outside = join(outsideRoot, 'escaped-workspace');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, probe.sentinel), probe.nonce);
      rmSync(probe.workspace, { recursive: true, force: true });
      symlinkSync(outside, probe.workspace, 'dir');
      break;
    }
    default:
      throw new Error(`unknown fake write mode: ${mode}`);
  }
}

export function createFakeCodexRunner({
  readResult = measuredUsage(2, 3),
  writeResult = measuredUsage(5, 7),
  writeMode = 'exact',
  outsideRoot,
} = {}) {
  const calls = [];
  const runSync = (entry, options) => {
    calls.push({ entry: structuredClone(entry), options: structuredClone(options) });
    const probe = parseWriteProbePrompt(entry.stdin);
    if (probe == null) return typeof readResult === 'function' ? readResult(entry, options) : readResult;
    if (writeResult?.ok === true) {
      mkdirSync(dirname(probe.workspace), { recursive: true });
      materializeWriteProbe(probe, writeMode, outsideRoot ?? dirname(probe.workspace));
    }
    return typeof writeResult === 'function' ? writeResult(entry, options) : writeResult;
  };
  return { calls, runSync };
}
