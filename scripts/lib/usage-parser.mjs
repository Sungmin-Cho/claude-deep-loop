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

export function parseGrokJson(stdout) {
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''), 'utf8');
  if (bytes.length === 0 || bytes.length > STREAM_LIMITS.claudeOutputBytes) return null;
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return null; }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)
    || JSON.stringify(Object.keys(parsed).sort())
      !== JSON.stringify(['model', 'num_turns', 'result', 'session_id', 'usage'])
    || typeof parsed.session_id !== 'string' || parsed.session_id.length === 0
    || parsed.session_id.length > 512 || /[\0\r\n]/.test(parsed.session_id)
    || typeof parsed.model !== 'string' || parsed.model.length === 0
    || parsed.model.length > 128 || /[\0\r\n]/.test(parsed.model)
    || parsed.num_turns !== 1
    || parsed.usage == null || typeof parsed.usage !== 'object' || Array.isArray(parsed.usage)
    || JSON.stringify(Object.keys(parsed.usage).sort()) !== JSON.stringify(['input_tokens', 'output_tokens'])
    || !safeTokenCount(parsed.usage.input_tokens) || !safeTokenCount(parsed.usage.output_tokens)
    || !safeTokenCount(parsed.usage.input_tokens + parsed.usage.output_tokens)
    || parsed.result == null || typeof parsed.result !== 'object' || Array.isArray(parsed.result)) return null;
  const finalMessage = Buffer.from(JSON.stringify(parsed.result));
  if (finalMessage.length === 0 || finalMessage.length > STREAM_LIMITS.finalMessageBytes) return null;
  return {
    usage: {
      num_turns: 1,
      input_tokens: parsed.usage.input_tokens,
      output_tokens: parsed.usage.output_tokens,
      tokens: parsed.usage.input_tokens + parsed.usage.output_tokens,
    },
    finalMessage,
    providerIdentity: { session_id: parsed.session_id, model_id: parsed.model },
  };
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createCodexJsonlParser({
  captureFinalMessage = false,
  captureProviderIdentity = false,
  providerModel = null,
} = {}) {
  let decoder = new StringDecoder('utf8');
  let line = '';
  let lineBytes = 0;
  let terminal = null;
  let finalMessage = null;
  let providerIdentity = null;
  let failure = null;
  let ended = false;
  let result = null;
  let utf8Remaining = 0;
  let utf8Min = 0x80;
  let utf8Max = 0xbf;

  function resetCurrentLine() {
    line = '';
    lineBytes = 0;
    decoder = new StringDecoder('utf8');
    utf8Remaining = 0;
    utf8Min = 0x80;
    utf8Max = 0xbf;
  }

  function fail(reason) {
    if (failure != null) return;
    failure = reason;
    resetCurrentLine();
    terminal = null;
    finalMessage = null;
    providerIdentity = null;
  }

  function validUtf8(segment) {
    for (const byte of segment) {
      if (utf8Remaining > 0) {
        if (byte < utf8Min || byte > utf8Max) return false;
        utf8Remaining -= 1;
        utf8Min = 0x80;
        utf8Max = 0xbf;
        continue;
      }
      if (byte <= 0x7f) continue;
      if (byte >= 0xc2 && byte <= 0xdf) {
        utf8Remaining = 1;
      } else if (byte === 0xe0) {
        utf8Remaining = 2;
        utf8Min = 0xa0;
      } else if ((byte >= 0xe1 && byte <= 0xec) || (byte >= 0xee && byte <= 0xef)) {
        utf8Remaining = 2;
      } else if (byte === 0xed) {
        utf8Remaining = 2;
        utf8Max = 0x9f;
      } else if (byte === 0xf0) {
        utf8Remaining = 3;
        utf8Min = 0x90;
      } else if (byte >= 0xf1 && byte <= 0xf3) {
        utf8Remaining = 3;
      } else if (byte === 0xf4) {
        utf8Remaining = 3;
        utf8Max = 0x8f;
      } else {
        return false;
      }
    }
    return true;
  }

  function consumeLine() {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    resetCurrentLine();
    if (failure != null) return;
    if (text.length === 0) {
      fail('codex-malformed-json');
      return;
    }

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
    if (captureProviderIdentity && event?.type === 'thread.started') {
      const emittedModel = Object.hasOwn(event, 'model') ? event.model : null;
      const identityKeys = emittedModel === null
        ? ['thread_id', 'type']
        : ['model', 'thread_id', 'type'];
      const boundModel = providerModel ?? emittedModel;
      if (providerIdentity != null
        || JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(identityKeys)
        || typeof event.thread_id !== 'string' || event.thread_id.length === 0
        || event.thread_id.length > 512 || /[\0\r\n]/.test(event.thread_id)
        || typeof boundModel !== 'string' || boundModel.length === 0
        || boundModel.length > 128 || /[\0\r\n]/.test(boundModel)
        || (emittedModel !== null && emittedModel !== boundModel)) {
        fail('codex-provider-identity-invalid');
        return;
      }
      providerIdentity = { session_id: event.thread_id, model_id: boundModel };
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
    const breakdownsValid = usage != null && typeof usage === 'object'
      && ['cached_input_tokens', 'reasoning_output_tokens']
        .every((field) => !Object.hasOwn(usage, field) || safeTokenCount(usage[field]));
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
      ...(Object.hasOwn(usage, 'cached_input_tokens') ? { cached_input_tokens: usage.cached_input_tokens } : {}),
      ...(Object.hasOwn(usage, 'reasoning_output_tokens') ? { reasoning_output_tokens: usage.reasoning_output_tokens } : {}),
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
        if (!validUtf8(segment)) {
          fail('codex-invalid-utf8');
          return;
        }
        line += decoder.write(segment);
        if (newline === -1) return;
        if (utf8Remaining !== 0) {
          fail('codex-invalid-utf8');
          return;
        }
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
        if (utf8Remaining !== 0) {
          fail('codex-invalid-utf8');
        } else {
          line += decoder.end();
          consumeLine();
        }
      }
      if (failure == null && captureProviderIdentity && providerIdentity == null) {
        fail('codex-provider-identity-missing');
      }
      result = failure != null
        ? { ok: false, reason: failure }
        : terminal == null
          ? { ok: false, reason: 'codex-missing-terminal' }
          : {
              ok: true,
              usage: terminal,
              ...(captureFinalMessage && finalMessage != null ? { finalMessage } : {}),
              ...(captureProviderIdentity ? { providerIdentity } : {}),
            };
      return result;
    },
  };
}
