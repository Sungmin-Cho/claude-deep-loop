import { types as utilTypes } from 'node:util';
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
    listProjectsReceipt = undefined, forkReceipt = { threadId: 'FORK-ID' },
    sendReceipt = {}, behaviors = {} } = {}) {
    this.listProjectsReceipt = listProjectsReceipt === undefined
      ? { schemaVersion: 1, projects: clone(projects) }
      : listProjectsReceipt;
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
    return this.#respond('list_projects', this.listProjectsReceipt);
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
const HOST_WIRE_JSON_MAX_BYTES = 1_048_576;

function decodeCanonicalAppWireValue(value, label) {
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value, 'utf8') > HOST_WIRE_JSON_MAX_BYTES) {
    throw new Error(`${label}_WIRE_INVALID`);
  }
  let decoded;
  try {
    decoded = JSON.parse(value);
  } catch {
    if (/^[\s\ufeff]*[\[{"]/u.test(value)) throw new Error(`${label}_WIRE_INVALID`);
    return value;
  }
  if (JSON.stringify(decoded) !== value) throw new Error(`${label}_WIRE_INVALID`);
  if (typeof decoded === 'string' && /^[\s\ufeff]*[\[{]/u.test(decoded)) {
    throw new Error(`${label}_WIRE_INVALID`);
  }
  return decoded;
}

function exactPlainDataEntries(value, maxEntries) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  let enumerableCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
    enumerableCount += 1;
    if (enumerableCount > maxEntries) return null;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxEntries || keys.some(key => typeof key !== 'string')) return null;
  const entries = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    entries.set(key, descriptor.value);
  }
  return entries;
}

function exactDenseDataArray(value, maxEntries) {
  if (utilTypes.isProxy(value) || !Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maxEntries) return null;
  let enumerableCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
    enumerableCount += 1;
    if (enumerableCount > maxEntries) return null;
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...Array(value.length).keys()].map(String);
  if (keys.length !== expected.length + 1 || keys.at(-1) !== 'length'
      || !expected.every((key, index) => keys[index] === key)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || length.enumerable || length.writable !== true
      || length.configurable !== false || length.value !== value.length
      || !Object.prototype.hasOwnProperty.call(length, 'value')) return null;
  const values = [];
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || descriptor.writable !== true
        || descriptor.configurable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    values.push(descriptor.value);
  }
  return values;
}

function preflightEnumerableEntryBound(value) {
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error('HOST_RECEIPT_INHERITED_PROPERTY_INVALID');
    }
    count += 1;
    if (count > HOST_RECEIPT_MAX_CONTAINER_ENTRIES) {
      throw new Error('HOST_RECEIPT_BOUNDS_INVALID');
    }
  }
}

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
  if (utilTypes.isProxy(value)) throw new Error('HOST_RECEIPT_PROXY_INVALID');
  if (seen.has(value)) throw new Error('HOST_RECEIPT_CYCLIC');
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error('HOST_RECEIPT_ARRAY_PROTOTYPE_INVALID');
    }
    if (value.length > HOST_RECEIPT_MAX_CONTAINER_ENTRIES) {
      throw new Error('HOST_RECEIPT_BOUNDS_INVALID');
    }
    // Reject an ordinary named-property flood incrementally before Reflect.ownKeys creates
    // its complete key array. The later reflective check remains necessary for symbols and
    // non-enumerable properties, which JavaScript exposes only through array-returning APIs.
    preflightEnumerableEntryBound(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > HOST_RECEIPT_MAX_CONTAINER_ENTRIES + 1) {
      throw new Error('HOST_RECEIPT_BOUNDS_INVALID');
    }
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
  preflightEnumerableEntryBound(value);
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
    const wire = await callHost(() => host.list_projects({}), 'DISCOVERY', timeoutMs);
    const raw = decodeCanonicalAppWireValue(wire, 'DISCOVERY');
    const envelope = exactPlainDataEntries(raw, 2);
    if (!envelope || envelope.size !== 2 || !envelope.has('schemaVersion')
        || !envelope.has('projects') || envelope.get('schemaVersion') !== 1) return absent();
    const rows = exactDenseDataArray(envelope.get('projects'), maxEntries);
    if (!rows) return absent();
    const projects = rows.map(item => {
      const fields = exactPlainDataEntries(item, 16);
      if (!fields || typeof fields.get('projectId') !== 'string'
          || typeof fields.get('projectKind') !== 'string'
          || typeof fields.get('path') !== 'string') {
        throw new Error('DISCOVERY_PROJECTION_INVALID');
      }
      for (const value of fields.values()) {
        if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
            && !(typeof value === 'number' && Number.isFinite(value))) {
          throw new Error('DISCOVERY_PROJECTION_INVALID');
        }
      }
      return { projectId: fields.get('projectId'), projectKind: fields.get('projectKind'),
        path: fields.get('path') };
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
    const wire = await callHost(
      () => host.create_thread({ target: clone(action.target), prompt: action.prompt }),
      'CREATE', timeoutMs);
    let receipt;
    try { receipt = decodeCanonicalAppWireValue(wire, 'CREATE'); }
    catch { throw new Error('CREATE_RECEIPT_INVALID'); }
    return { threadId: exactThreadId(receipt, 'CREATE') };
  }
  if (action?.tool === 'fork_thread') {
    const forkWire = await callHost(
      () => host.fork_thread({ environment: clone(action.environment) }), 'FORK', timeoutMs);
    let fork;
    try { fork = decodeCanonicalAppWireValue(forkWire, 'FORK'); }
    catch { throw new Error('FORK_RECEIPT_INVALID'); }
    const threadId = exactThreadId(fork, 'FORK');
    const sendWire = await callHost(() => host.send_message_to_thread({
      threadId, prompt: action.followup?.prompt,
    }), 'SEND', timeoutMs);
    let sent;
    try { sent = decodeCanonicalAppWireValue(sendWire, 'SEND'); }
    catch { throw new Error('SEND_RECEIPT_MISMATCH'); }
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
