import { validateOpaqueId } from '../../scripts/lib/host-surface.mjs';

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

const HOST_LABEL = {
  list_projects: 'DISCOVERY',
  create_thread: 'CREATE',
  fork_thread: 'FORK',
  send_message_to_thread: 'SEND',
};

export class FakeAppHost {
  constructor({ projects = [], createReceipt = { threadId: 'CREATE-ID' },
    forkReceipt = { threadId: 'FORK-ID' }, sendReceipt = {}, behaviors = {} } = {}) {
    this.projects = clone(projects);
    // Preserve receipt prototypes, symbols, accessors, and descriptors so the strict validator—not
    // structuredClone normalization—sees the exact host return value under test.
    this.createReceipt = createReceipt;
    this.forkReceipt = forkReceipt;
    this.sendReceipt = sendReceipt;
    this.behaviors = clone(behaviors);
    this.calls = [];
  }

  async #respond(tool, value) {
    const behavior = this.behaviors[tool] ?? 'resolve';
    if (behavior === 'throw') throw new Error(`${HOST_LABEL[tool]}_HOST_THROW`);
    if (behavior === 'timeout') throw new Error(`${HOST_LABEL[tool]}_HOST_TIMEOUT`);
    if (behavior === 'no-return') return new Promise(() => {});
    if (behavior === 'undefined') return undefined;
    if (behavior !== 'resolve') throw new Error('FAKE_HOST_BEHAVIOR_INVALID');
    return value;
  }

  async list_projects(args = {}) {
    this.calls.push({ tool: 'list_projects', args: clone(args) });
    return this.#respond('list_projects', this.projects);
  }

  async create_thread(args) {
    this.calls.push({ tool: 'create_thread', args: clone(args) });
    return this.#respond('create_thread', this.createReceipt);
  }

  async fork_thread(args) {
    this.calls.push({ tool: 'fork_thread', args: clone(args) });
    return this.#respond('fork_thread', this.forkReceipt);
  }

  async send_message_to_thread(args) {
    this.calls.push({ tool: 'send_message_to_thread', args: clone(args) });
    return this.#respond('send_message_to_thread', this.sendReceipt);
  }
}

const HOST_RECEIPT_MAX_DEPTH = 32;
const HOST_RECEIPT_MAX_NODES = 1024;
const HOST_RECEIPT_MAX_CONTAINER_ENTRIES = 256;

function collectIdFields(value, path = '$', seen = new Set(), found = [],
  budget = { nodes: 0 }, depth = 0) {
  if (depth > HOST_RECEIPT_MAX_DEPTH
      || ++budget.nodes > HOST_RECEIPT_MAX_NODES) {
    throw new Error('HOST_RECEIPT_BOUNDS_INVALID');
  }
  if (value === null) return found;
  if (typeof value !== 'object') {
    if (typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))) return found;
    throw new Error('HOST_RECEIPT_VALUE_INVALID');
  }
  if (seen.has(value)) throw new Error('HOST_RECEIPT_CYCLIC');
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error('HOST_RECEIPT_ARRAY_PROTOTYPE_INVALID');
    }
    if (value.length > HOST_RECEIPT_MAX_CONTAINER_ENTRIES) {
      throw new Error('HOST_RECEIPT_BOUNDS_INVALID');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) {
      throw new Error('HOST_RECEIPT_SYMBOL_INVALID');
    }
    const expected = [...Array(value.length).keys()].map(String);
    if (keys.length !== expected.length + 1 || keys.at(-1) !== 'length'
        || !expected.every((key, index) => keys[index] === key)) {
      throw new Error('HOST_RECEIPT_ARRAY_KEYS_INVALID');
    }
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || length.enumerable || !Object.prototype.hasOwnProperty.call(length, 'value')
        || length.writable !== true || length.configurable !== false
        || length.value !== value.length) throw new Error('HOST_RECEIPT_ARRAY_LENGTH_INVALID');
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true
          || descriptor.writable !== true || descriptor.configurable !== true
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error('HOST_RECEIPT_PROPERTY_INVALID');
      }
      collectIdFields(descriptor.value, `${path}[${key}]`, seen, found, budget, depth + 1);
    }
    seen.delete(value);
    return found;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('HOST_RECEIPT_PROTOTYPE_INVALID');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > HOST_RECEIPT_MAX_CONTAINER_ENTRIES) {
    throw new Error('HOST_RECEIPT_BOUNDS_INVALID');
  }
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error('HOST_RECEIPT_SYMBOL_INVALID');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('HOST_RECEIPT_PROPERTY_INVALID');
    }
    const next = `${path}.${key}`;
    if (/(?:ids?|identifiers?)$/iu.test(key)) {
      found.push({ path: next, key, value: descriptor.value });
    }
    collectIdFields(descriptor.value, next, seen, found, budget, depth + 1);
  }
  seen.delete(value);
  return found;
}

function exactThreadId(receipt, label) {
  const own = Object.prototype.hasOwnProperty;
  let fields;
  try { fields = collectIdFields(receipt); }
  catch { throw new Error(`${label}_RECEIPT_INVALID`); }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(receipt))
      || !own.call(receipt, 'threadId') || fields.length !== 1
      || fields[0].path !== '$.threadId') {
    throw new Error(`${label}_RECEIPT_INVALID`);
  }
  try {
    return validateOpaqueId(fields[0].value, {
      label: `${label.toLowerCase()}-thread-id`, maxBytes: 512,
    });
  } catch {
    throw new Error(`${label}_RECEIPT_INVALID`);
  }
}

async function callHost(thunk, label, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('HOST_TIMEOUT_INVALID');
  }
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(thunk),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_NO_RETURN`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function boundedRootPrepareInput(host, currentHostTaskCwd, {
  timeoutMs = 5_000, maxEntries = 256, maxBytes = 32_768,
} = {}) {
  const absent = () => ({ discoveryAvailable: false,
    line: JSON.stringify({ host_task_cwd: currentHostTaskCwd }) });
  try {
    const raw = await callHost(() => host.list_projects({}), 'DISCOVERY', timeoutMs);
    if (!Array.isArray(raw) || raw.length > maxEntries) return absent();
    const projects = raw.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
          || typeof item.projectId !== 'string' || typeof item.projectKind !== 'string'
          || typeof item.path !== 'string') throw new Error('DISCOVERY_PROJECTION_INVALID');
      return { projectId: item.projectId, projectKind: item.projectKind, path: item.path };
    });
    const line = JSON.stringify({ host_task_cwd: currentHostTaskCwd, projects });
    return Buffer.byteLength(line, 'utf8') <= maxBytes
      ? { discoveryAvailable: true, line }
      : absent();
  } catch {
    return absent();
  }
}

export async function executePreparedAction(action, host, { timeoutMs = 5_000 } = {}) {
  if (action?.tool === 'create_thread') {
    const receipt = await callHost(
      () => host.create_thread({ target: clone(action.target), prompt: action.prompt }),
      'CREATE', timeoutMs);
    return { threadId: exactThreadId(receipt, 'CREATE') };
  }
  if (action?.tool === 'fork_thread') {
    const fork = await callHost(
      () => host.fork_thread({ environment: clone(action.environment) }), 'FORK', timeoutMs);
    const threadId = exactThreadId(fork, 'FORK');
    const sent = await callHost(() => host.send_message_to_thread({
      threadId, prompt: action.followup?.prompt,
    }), 'SEND', timeoutMs);
    const scalar = sent === null || sent === undefined || typeof sent === 'string'
      || typeof sent === 'boolean' || (typeof sent === 'number' && Number.isFinite(sent));
    if (!scalar) {
      let fields;
      try { fields = collectIdFields(sent); }
      catch { throw new Error('SEND_RECEIPT_MISMATCH'); }
      if (fields.length > 0 && (fields.length !== 1 || fields[0].path !== '$.threadId'
          || !Object.prototype.hasOwnProperty.call(sent, 'threadId')
          || sent.threadId !== threadId)) throw new Error('SEND_RECEIPT_MISMATCH');
    }
    return { threadId };
  }
  throw new Error('APP_ACTION_INVALID');
}
