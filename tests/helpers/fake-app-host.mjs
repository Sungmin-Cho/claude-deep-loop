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
  constructor({ projects = [], createReceipt = { threadId: 'CREATE-ID', hostId: 'CREATE-HOST' },
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

function decodeCanonicalJsonWireValue(value, label, { requireJson = false } = {}) {
  if (typeof value !== 'string') return value;
  if (Buffer.byteLength(value, 'utf8') > HOST_WIRE_JSON_MAX_BYTES) {
    throw new Error(`${label}_WIRE_INVALID`);
  }
  let decoded;
  try {
    decoded = JSON.parse(value);
  } catch {
    if (requireJson || /^[\s\ufeff]*[\[{"]/u.test(value)) {
      throw new Error(`${label}_WIRE_INVALID`);
    }
    return value;
  }
  if (JSON.stringify(decoded) !== value) throw new Error(`${label}_WIRE_INVALID`);
  if (typeof decoded === 'string' && /^[\s\ufeff]*[\[{]/u.test(decoded)) {
    throw new Error(`${label}_WIRE_INVALID`);
  }
  if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      && Object.hasOwn(decoded, 'contentItems') && Object.hasOwn(decoded, 'success')) {
    throw new Error(`${label}_WIRE_INVALID`);
  }
  return decoded;
}

function sameBuiltinValue(actual, expected, depth = 0) {
  if (Object.is(actual, expected)) return true;
  if (depth > 4 || typeof actual !== typeof expected) return false;
  if (typeof expected === 'function') {
    if (utilTypes.isProxy(actual) || utilTypes.isProxy(expected)) return false;
    try {
      return Function.prototype.toString.call(actual)
        === Function.prototype.toString.call(expected);
    } catch {
      return false;
    }
  }
  if (!actual || !expected || typeof expected !== 'object'
      || utilTypes.isProxy(actual) || utilTypes.isProxy(expected)
      || Object.getPrototypeOf(actual) !== Object.getPrototypeOf(expected)) return false;
  const actualKeys = Reflect.ownKeys(actual);
  const expectedKeys = Reflect.ownKeys(expected);
  if (actualKeys.length !== expectedKeys.length
      || !expectedKeys.every((key, index) => actualKeys[index] === key)) return false;
  return expectedKeys.every(key => {
    const left = Object.getOwnPropertyDescriptor(actual, key);
    const right = Object.getOwnPropertyDescriptor(expected, key);
    if (!left || !right || left.enumerable !== right.enumerable
        || left.configurable !== right.configurable
        || left.writable !== right.writable
        || Object.prototype.hasOwnProperty.call(left, 'value')
          !== Object.prototype.hasOwnProperty.call(right, 'value')) return false;
    return sameBuiltinValue(left.value, right.value, depth + 1)
      && sameBuiltinValue(left.get, right.get, depth + 1)
      && sameBuiltinValue(left.set, right.set, depth + 1);
  });
}

function sameBuiltinPrototype(actual, expected) {
  if (!actual || utilTypes.isProxy(actual)) return false;
  const actualKeys = Reflect.ownKeys(actual);
  const expectedKeys = Reflect.ownKeys(expected);
  if (actualKeys.length !== expectedKeys.length
      || !expectedKeys.every((key, index) => actualKeys[index] === key)) return false;
  return expectedKeys.every(key => {
    const left = Object.getOwnPropertyDescriptor(actual, key);
    const right = Object.getOwnPropertyDescriptor(expected, key);
    if (!left || !right || left.enumerable !== right.enumerable
        || left.configurable !== right.configurable
        || left.writable !== right.writable
        || Object.prototype.hasOwnProperty.call(left, 'value')
          !== Object.prototype.hasOwnProperty.call(right, 'value')) return false;
    return sameBuiltinValue(left.value, right.value)
      && sameBuiltinValue(left.get, right.get)
      && sameBuiltinValue(left.set, right.set);
  });
}

function hasIntrinsicConstructorBacklink(actual, expected) {
  const leftConstructor = Object.getOwnPropertyDescriptor(actual, 'constructor');
  const rightConstructor = Object.getOwnPropertyDescriptor(expected, 'constructor');
  if (!leftConstructor || !rightConstructor
      || !Object.prototype.hasOwnProperty.call(leftConstructor, 'value')
      || !Object.prototype.hasOwnProperty.call(rightConstructor, 'value')
      || typeof leftConstructor.value !== 'function'
      || typeof rightConstructor.value !== 'function'
      || utilTypes.isProxy(leftConstructor.value)) return false;
  const leftPrototype = Object.getOwnPropertyDescriptor(leftConstructor.value, 'prototype');
  const rightPrototype = Object.getOwnPropertyDescriptor(rightConstructor.value, 'prototype');
  return Boolean(leftPrototype && rightPrototype
    && Object.prototype.hasOwnProperty.call(leftPrototype, 'value')
    && Object.prototype.hasOwnProperty.call(rightPrototype, 'value')
    && leftPrototype.value === actual && rightPrototype.value === expected
    && leftPrototype.enumerable === rightPrototype.enumerable
    && leftPrototype.configurable === rightPrototype.configurable
    && leftPrototype.writable === rightPrototype.writable);
}

function isPlainObjectPrototype(prototype) {
  if (prototype === null || prototype === Object.prototype) return true;
  return !utilTypes.isProxy(prototype) && Object.getPrototypeOf(prototype) === null
    && sameBuiltinPrototype(prototype, Object.prototype)
    && hasIntrinsicConstructorBacklink(prototype, Object.prototype);
}

function isCanonicalArrayPrototype(prototype) {
  if (prototype === Array.prototype) return true;
  if (!prototype || utilTypes.isProxy(prototype)
      || !sameBuiltinPrototype(prototype, Array.prototype)) return false;
  const parent = Object.getPrototypeOf(prototype);
  return parent !== null && isPlainObjectPrototype(parent)
    && hasIntrinsicConstructorBacklink(prototype, Array.prototype);
}

function exactPlainDataEntries(value, maxEntries) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)
      || !isPlainObjectPrototype(Object.getPrototypeOf(value))) return null;
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
      || !isCanonicalArrayPrototype(Object.getPrototypeOf(value))
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

function decodeCanonicalAppWireValue(value, label) {
  if (typeof value === 'string') return decodeCanonicalJsonWireValue(value, label);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || utilTypes.isProxy(value)) return value;
  const contentItems = Object.getOwnPropertyDescriptor(value, 'contentItems');
  const success = Object.getOwnPropertyDescriptor(value, 'success');
  if (contentItems == null && success == null) return value;
  const envelope = exactPlainDataEntries(value, 2);
  if (!envelope || envelope.size !== 2 || !envelope.has('contentItems')
      || !envelope.has('success') || envelope.get('success') !== true) {
    throw new Error(`${label}_WIRE_INVALID`);
  }
  const items = exactDenseDataArray(envelope.get('contentItems'), 1);
  if (!items || items.length !== 1) throw new Error(`${label}_WIRE_INVALID`);
  const item = exactPlainDataEntries(items[0], 2);
  if (!item || item.size !== 2 || item.get('type') !== 'inputText'
      || typeof item.get('text') !== 'string') {
    throw new Error(`${label}_WIRE_INVALID`);
  }
  return decodeCanonicalJsonWireValue(item.get('text'), label, { requireJson: true });
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
    if (!isCanonicalArrayPrototype(Object.getPrototypeOf(value))) {
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
  if (!isPlainObjectPrototype(prototype)) {
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
  const hasCreateHostId = label === 'CREATE' && own.call(receipt ?? {}, 'hostId');
  const expectedPaths = hasCreateHostId
    ? new Set(['$.threadId', '$.hostId'])
    : new Set(['$.threadId']);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || !isPlainObjectPrototype(Object.getPrototypeOf(receipt))
      || !own.call(receipt, 'threadId') || fields.length !== expectedPaths.size
      || fields.some(field => !expectedPaths.has(field.path))) {
    throw new Error(`${label}_RECEIPT_INVALID`);
  }
  try {
    if (hasCreateHostId) validateOpaqueId(receipt.hostId, {
      label: 'create-host-id', maxBytes: 512,
    });
    return validateOpaqueId(fields.find(field => field.path === '$.threadId').value, {
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
