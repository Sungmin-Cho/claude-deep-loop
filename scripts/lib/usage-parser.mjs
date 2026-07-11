import { StringDecoder } from 'node:string_decoder';

export const STREAM_LIMITS = Object.freeze({
  codexLineBytes: 32 * 1024 * 1024,
  finalMessageBytes: 256 * 1024,
  stderrBytes: 64 * 1024,
  claudeOutputBytes: 4 * 1024 * 1024,
});

export function parseClaudeUsage(stdout) {
  const bytes = Buffer.isBuffer(stdout) ? stdout.length : Buffer.byteLength(String(stdout || ''), 'utf8');
  if (bytes > STREAM_LIMITS.claudeOutputBytes) return null;

  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
  let turns = null;
  let tokens = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed) {
      if (Number.isFinite(parsed.num_turns)) turns = parsed.num_turns;
      const input = parsed.usage?.input_tokens;
      const output = parsed.usage?.output_tokens;
      if (Number.isFinite(input) || Number.isFinite(output)) {
        tokens = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
      }
    }
  } catch {
    // Legacy Claude output can contain text around its metric-bearing JSON.
  }
  if (turns == null) {
    const match = text.match(/"(?:num_turns|turns)"\s*:\s*(\d+)/);
    if (match) turns = Number(match[1]);
  }
  if (!Number.isFinite(turns) && !Number.isFinite(tokens)) return null;
  return { num_turns: turns, tokens };
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createCodexJsonlParser({ captureFinalMessage = false } = {}) {
  let decoder = new StringDecoder('utf8');
  let line = '';
  let lineBytes = 0;
  let terminal = null;
  let finalMessage = null;
  let failure = null;
  let ended = false;
  let result = null;

  function fail(reason) {
    failure ??= reason;
  }

  function consumeLine() {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    line = '';
    lineBytes = 0;
    decoder = new StringDecoder('utf8');
    if (text.length === 0 || failure != null) return;

    let event;
    try {
      event = JSON.parse(text);
    } catch {
      fail('codex-malformed-json');
      return;
    }

    if (event?.type === 'error') {
      fail('codex-top-level-error');
      return;
    }
    if (event?.type === 'turn.failed') {
      fail('codex-turn-failed');
      return;
    }
    if (captureFinalMessage && event?.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (typeof event.item.text !== 'string') {
        fail('codex-invalid-final-message');
        return;
      }
      const bytes = Buffer.from(event.item.text, 'utf8');
      if (bytes.length > STREAM_LIMITS.finalMessageBytes) {
        fail('codex-final-message-overflow');
        return;
      }
      finalMessage = bytes;
      return;
    }
    if (event?.type !== 'turn.completed') return;
    if (terminal != null) {
      fail('codex-multiple-terminals');
      return;
    }
    const usage = event.usage;
    const breakdownsValid = ['cached_input_tokens', 'reasoning_output_tokens']
      .every((field) => usage?.[field] == null || safeTokenCount(usage[field]));
    const tokens = usage?.input_tokens + usage?.output_tokens;
    if (!safeTokenCount(usage?.input_tokens) || !safeTokenCount(usage?.output_tokens)
      || !safeTokenCount(tokens) || !breakdownsValid) {
      fail('codex-invalid-usage');
      return;
    }
    terminal = {
      num_turns: 1,
      tokens,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      ...(usage.cached_input_tokens == null ? {} : { cached_input_tokens: usage.cached_input_tokens }),
      ...(usage.reasoning_output_tokens == null ? {} : { reasoning_output_tokens: usage.reasoning_output_tokens }),
    };
  }

  return {
    write(chunk) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError('Codex JSONL parser write() requires a Buffer');
      if (ended) throw new Error('CODEX_JSONL_PARSER_ENDED');
      if (failure != null) return;

      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const segment = chunk.subarray(offset, end);
        lineBytes += segment.length;
        if (lineBytes > STREAM_LIMITS.codexLineBytes) {
          fail('codex-line-overflow');
          return;
        }
        line += decoder.write(segment);
        if (newline === -1) return;
        line += decoder.end();
        consumeLine();
        if (failure != null) return;
        offset = newline + 1;
      }
    },

    end() {
      if (result != null) return result;
      ended = true;
      if (failure == null && lineBytes > 0) {
        line += decoder.end();
        consumeLine();
      }
      result = failure != null
        ? { ok: false, reason: failure }
        : terminal == null
          ? { ok: false, reason: 'codex-missing-terminal' }
          : {
              ok: true,
              usage: terminal,
              ...(captureFinalMessage && finalMessage != null ? { finalMessage } : {}),
            };
      return result;
    },
  };
}
