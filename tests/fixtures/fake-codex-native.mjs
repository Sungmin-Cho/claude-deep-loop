import {
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { makeCodexPreflightReceipt } from '../../scripts/lib/budget.mjs';

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

function materializeUsageReceipt(result, descriptor) {
  if (result?.ok !== true || descriptor == null) return result;
  try {
    if (typeof descriptor !== 'object' || Array.isArray(descriptor)
      || typeof descriptor.journalPath !== 'string' || !isAbsolute(descriptor.journalPath)) {
      throw new Error('invalid receipt descriptor');
    }
    const receipt = makeCodexPreflightReceipt({ ...descriptor, usage: result.usage });
    writeFileSync(descriptor.journalPath, `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    return { ...result, usageReceipt: receipt };
  } catch {
    return { ok: false, reason: 'usage-receipt-write-failed' };
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
    if (probe == null) {
      const result = typeof readResult === 'function' ? readResult(entry, options) : readResult;
      return materializeUsageReceipt(result, options?.usageReceipt);
    }
    if (writeResult?.ok === true) {
      mkdirSync(dirname(probe.workspace), { recursive: true });
      materializeWriteProbe(probe, writeMode, outsideRoot ?? dirname(probe.workspace));
    }
    const result = typeof writeResult === 'function' ? writeResult(entry, options) : writeResult;
    return materializeUsageReceipt(result, options?.usageReceipt);
  };
  return { calls, runSync };
}
