function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class FakeStructuredProcess {
  constructor({ readyToken, result, echoInput = false, maxBytes = 64 * 1024 } = {}) {
    if (typeof readyToken !== 'string' || readyToken.length === 0) throw new Error('READY_TOKEN_REQUIRED');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('MAX_BYTES_INVALID');
    this.readyToken = readyToken;
    this.result = clone(result);
    this.echoInput = echoInput;
    this.maxBytes = maxBytes;
    this.started = false;
    this.consumed = false;
    this.transcript = [];
    this.echoedInputs = [];
  }

  start() {
    if (this.started) throw new Error('PROCESS_ALREADY_STARTED');
    this.started = true;
    this.transcript.push(this.readyToken);
    return this.readyToken;
  }

  writeLine(line) {
    if (!this.started) throw new Error('WRITE_BEFORE_READY');
    if (this.consumed) throw new Error('STRUCTURED_INPUT_ALREADY_CONSUMED');
    this.consumed = true;
    if (typeof line !== 'string' || !line.endsWith('\n')
        || /[\r\n]/u.test(line.slice(0, -1))) {
      throw new Error('STRUCTURED_LINE_INVALID');
    }
    const payload = line.slice(0, -1);
    if (Buffer.byteLength(payload, 'utf8') > this.maxBytes) {
      throw new Error('STRUCTURED_LINE_TOO_LARGE');
    }
    if (this.echoInput) {
      this.transcript.push(payload);
      this.echoedInputs.push(payload);
    }
    this.transcript.push(JSON.stringify(this.result));
    return clone(this.result);
  }
}

export class FakeAppHost {
  constructor({ projects = [], createReceipt = { threadId: 'CREATE-ID' },
    forkReceipt = { threadId: 'FORK-ID' }, sendReceipt = {} } = {}) {
    this.projects = clone(projects);
    this.createReceipt = clone(createReceipt);
    this.forkReceipt = clone(forkReceipt);
    this.sendReceipt = clone(sendReceipt);
    this.calls = [];
  }

  async list_projects(args = {}) {
    this.calls.push({ tool: 'list_projects', args: clone(args) });
    return clone(this.projects);
  }

  async create_thread(args) {
    this.calls.push({ tool: 'create_thread', args: clone(args) });
    return clone(this.createReceipt);
  }

  async fork_thread(args) {
    this.calls.push({ tool: 'fork_thread', args: clone(args) });
    return clone(this.forkReceipt);
  }

  async send_message_to_thread(args) {
    this.calls.push({ tool: 'send_message_to_thread', args: clone(args) });
    return clone(this.sendReceipt);
  }
}

function exactThreadId(receipt, label) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || typeof receipt.threadId !== 'string' || receipt.threadId.length === 0
      || Object.prototype.hasOwnProperty.call(receipt, 'clientThreadId')) {
    throw new Error(`${label}_RECEIPT_INVALID`);
  }
  return receipt.threadId;
}

export async function executePreparedAction(action, host) {
  if (action?.tool === 'create_thread') {
    const receipt = await host.create_thread({ target: clone(action.target), prompt: action.prompt });
    return { threadId: exactThreadId(receipt, 'CREATE') };
  }
  if (action?.tool === 'fork_thread') {
    const fork = await host.fork_thread({ environment: clone(action.environment) });
    const threadId = exactThreadId(fork, 'FORK');
    const sent = await host.send_message_to_thread({ threadId, prompt: action.followup?.prompt });
    if (sent && typeof sent === 'object' && Object.prototype.hasOwnProperty.call(sent, 'threadId')
        && sent.threadId !== threadId) throw new Error('SEND_RECEIPT_MISMATCH');
    return { threadId };
  }
  throw new Error('APP_ACTION_INVALID');
}
