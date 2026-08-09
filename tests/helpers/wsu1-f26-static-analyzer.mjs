import { readFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const byteSort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function decodeString(raw) {
  if (raw[0] === '"') return JSON.parse(raw);
  return raw.slice(1, -1).replace(/\\(['\\])/g, '$1');
}

export function tokenize(source, file = '<source>') {
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const advance = (text) => {
    for (const char of text) {
      if (char === '\n') { line += 1; column = 1; } else column += 1;
    }
    index += text.length;
  };
  const push = (type, value, raw, start, startLine, startColumn) => {
    tokens.push({ type, value, raw, start, end: start + raw.length, line: startLine, column: startColumn });
  };
  while (index < source.length) {
    const start = index;
    const startLine = line;
    const startColumn = column;
    const char = source[index];
    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < source.length && /\s/.test(source[end])) end += 1;
      advance(source.slice(index, end));
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      advance(source.slice(index, end < 0 ? source.length : end));
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error(`UNTERMINATED_COMMENT: ${file}:${line}:${column}`);
      advance(source.slice(index, end + 2));
      continue;
    }
    if (char === '"' || char === "'") {
      let end = index + 1;
      let escaped = false;
      for (; end < source.length; end += 1) {
        const next = source[end];
        if (!escaped && next === char) { end += 1; break; }
        if (!escaped && (next === '\n' || next === '\r')) {
          throw new Error(`UNTERMINATED_STRING: ${file}:${line}:${column}`);
        }
        escaped = !escaped && next === '\\';
        if (next !== '\\') escaped = false;
      }
      if (end > source.length || source[end - 1] !== char) {
        throw new Error(`UNTERMINATED_STRING: ${file}:${line}:${column}`);
      }
      const raw = source.slice(index, end);
      push('string', decodeString(raw), raw, start, startLine, startColumn);
      advance(raw);
      continue;
    }
    if (char === '`') {
      let end = index + 1;
      let escaped = false;
      let dynamic = false;
      for (; end < source.length; end += 1) {
        const next = source[end];
        if (!escaped && next === '`') { end += 1; break; }
        if (!escaped && next === '$' && source[end + 1] === '{') dynamic = true;
        escaped = !escaped && next === '\\';
        if (next !== '\\') escaped = false;
      }
      if (end > source.length || source[end - 1] !== '`') {
        throw new Error(`UNTERMINATED_TEMPLATE: ${file}:${line}:${column}`);
      }
      const raw = source.slice(index, end);
      push(dynamic ? 'dynamic-template' : 'string', raw.slice(1, -1), raw, start, startLine, startColumn);
      advance(raw);
      continue;
    }
    if (char === '/') {
      const previous = tokens.at(-1)?.value;
      const expressionStart = previous === undefined
        || ['=', '(', '[', '{', ',', ':', ';', 'return', 'throw', 'case', '=>', '!', '&&', '||', '??', '?'].includes(previous);
      if (expressionStart) {
        let end = index + 1;
        let escaped = false;
        let inClass = false;
        for (; end < source.length; end += 1) {
          const next = source[end];
          if (!escaped && next === '[') inClass = true;
          if (!escaped && next === ']') inClass = false;
          if (!escaped && !inClass && next === '/') { end += 1; break; }
          if (!escaped && (next === '\n' || next === '\r')) break;
          escaped = !escaped && next === '\\';
          if (next !== '\\') escaped = false;
        }
        if (source[end - 1] === '/') {
          while (end < source.length && /[A-Za-z]/.test(source[end])) end += 1;
          const raw = source.slice(index, end);
          push('regex', raw, raw, start, startLine, startColumn);
          advance(raw);
          continue;
        }
      }
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      const raw = source.slice(index, end);
      push('identifier', raw, raw, start, startLine, startColumn);
      advance(raw);
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[0-9A-Fa-f_xXn.eE+-]/.test(source[end])) end += 1;
      const raw = source.slice(index, end);
      push('number', raw, raw, start, startLine, startColumn);
      advance(raw);
      continue;
    }
    const multi = ['===', '!==', '>>>', '**=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.',
      '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '...'].find((item) => source.startsWith(item, index));
    const raw = multi || char;
    push('punctuator', raw, raw, start, startLine, startColumn);
    advance(raw);
  }
  return tokens;
}

function matching(tokens, start, open, close) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].type === 'punctuator' && tokens[index].value === open) depth += 1;
    if (tokens[index].type === 'punctuator' && tokens[index].value === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function sourceTarget(file, specifier, modules) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const target = resolve(dirname(file), specifier);
  return modules.get(target) || modules.get(`${target}.mjs`) || null;
}

function parseSpecifiers(tokens, openIndex, closeIndex) {
  const entries = [];
  let index = openIndex + 1;
  while (index < closeIndex) {
    if (tokens[index].value === ',') { index += 1; continue; }
    const local = tokens[index]?.value;
    if (!IDENTIFIER.test(local || '')) throw new Error(`EXPORT_SPECIFIER_INVALID:${tokens[index]?.line}`);
    index += 1;
    let exported = local;
    if (tokens[index]?.value === 'as') {
      exported = tokens[index + 1]?.value;
      if (!IDENTIFIER.test(exported || '')) throw new Error(`EXPORT_SPECIFIER_INVALID:${tokens[index]?.line}`);
      index += 2;
    }
    entries.push({ local, exported });
  }
  return entries;
}

function parseModule(file) {
  const source = readFileSync(file, 'utf8');
  const tokens = tokenize(source, file);
  const module = {
    file,
    idFile: basename(file),
    source,
    tokens,
    imports: new Map(),
    declarations: new Set(),
    exports: [],
    stars: [],
    failures: [],
  };
  let brace = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'punctuator' && token.value === '{') { brace += 1; continue; }
    if (token.type === 'punctuator' && token.value === '}') { brace -= 1; continue; }
    if (brace !== 0) continue;

    if (token.value === 'function' || token.value === 'class') {
      const name = tokens[index + 1]?.value;
      if (IDENTIFIER.test(name || '')) module.declarations.add(name);
      continue;
    }
    if (['const', 'let', 'var'].includes(token.value)) {
      let cursor = index + 1;
      let nesting = 0;
      let expectName = true;
      while (cursor < tokens.length) {
        const value = tokens[cursor].value;
        if (nesting === 0 && value === ';') break;
        if (expectName && nesting === 0 && IDENTIFIER.test(value)) {
          module.declarations.add(value);
          expectName = false;
        }
        if (tokens[cursor].type === 'punctuator' && ['(', '[', '{'].includes(value)) nesting += 1;
        if (tokens[cursor].type === 'punctuator' && [')', ']', '}'].includes(value)) nesting -= 1;
        if (tokens[cursor].type === 'punctuator' && nesting === 0 && value === ',') expectName = true;
        cursor += 1;
      }
      continue;
    }
    if (token.value === 'import') {
      if (tokens[index + 1]?.value === '.' || tokens[index + 1]?.value === '(') continue;
      let cursor = index + 1;
      if (tokens[cursor]?.type === 'string') continue;
      const pending = [];
      if (IDENTIFIER.test(tokens[cursor]?.value || '')) {
        pending.push({ imported: 'default', local: tokens[cursor].value });
        cursor += 1;
        if (tokens[cursor]?.value === ',') cursor += 1;
      }
      if (tokens[cursor]?.value === '*') {
        if (tokens[cursor + 1]?.value !== 'as' || !IDENTIFIER.test(tokens[cursor + 2]?.value || '')) {
          module.failures.push({ guard: 2, file: basename(file), reason: 'import-namespace-parse' });
          continue;
        }
        pending.push({ imported: '*', local: tokens[cursor + 2].value });
        cursor += 3;
      } else if (tokens[cursor]?.value === '{') {
        const close = matching(tokens, cursor, '{', '}');
        if (close < 0) { module.failures.push({ guard: 2, file: basename(file), reason: 'import-brace-parse' }); continue; }
        pending.push(...parseSpecifiers(tokens, cursor, close).map(({ local, exported }) => ({
          imported: local,
          local: exported,
        })));
        cursor = close + 1;
      }
      while (cursor < tokens.length && tokens[cursor].value !== 'from' && tokens[cursor].value !== ';') cursor += 1;
      const specifier = tokens[cursor]?.value === 'from' ? tokens[cursor + 1]?.value : null;
      if (typeof specifier !== 'string') {
        module.failures.push({ guard: 2, file: basename(file), reason: 'import-source-parse' });
        continue;
      }
      for (const item of pending) module.imports.set(item.local, { source: specifier, imported: item.imported });
      continue;
    }
    if (token.value !== 'export') continue;
    let cursor = index + 1;
    if (tokens[cursor]?.value === 'async') cursor += 1;
    if (tokens[cursor]?.value === 'default') {
      module.exports.push({ exported: 'default', local: 'default', kind: 'default' });
      continue;
    }
    if (tokens[cursor]?.value === 'function' || tokens[cursor]?.value === 'class') {
      const name = tokens[cursor + 1]?.value;
      if (!IDENTIFIER.test(name || '')) {
        module.failures.push({ guard: 2, file: basename(file), reason: 'export-declaration-parse' });
      } else {
        module.declarations.add(name);
        module.exports.push({ exported: name, local: name, kind: 'declaration' });
      }
      continue;
    }
    if (['const', 'let', 'var'].includes(tokens[cursor]?.value)) {
      cursor += 1;
      let nesting = 0;
      let expectName = true;
      while (cursor < tokens.length) {
        const value = tokens[cursor].value;
        if (nesting === 0 && value === ';') break;
        if (expectName && nesting === 0 && IDENTIFIER.test(value)) {
          module.declarations.add(value);
          module.exports.push({ exported: value, local: value, kind: 'snapshot-declaration' });
          expectName = false;
        }
        if (tokens[cursor].type === 'punctuator' && ['(', '[', '{'].includes(value)) nesting += 1;
        if (tokens[cursor].type === 'punctuator' && [')', ']', '}'].includes(value)) nesting -= 1;
        if (tokens[cursor].type === 'punctuator' && nesting === 0 && value === ',') expectName = true;
        cursor += 1;
      }
      continue;
    }
    if (tokens[cursor]?.value === '{') {
      const close = matching(tokens, cursor, '{', '}');
      if (close < 0) { module.failures.push({ guard: 2, file: basename(file), reason: 'export-brace-parse' }); continue; }
      const entries = parseSpecifiers(tokens, cursor, close);
      cursor = close + 1;
      const from = tokens[cursor]?.value === 'from' ? tokens[cursor + 1]?.value : null;
      for (const entry of entries) module.exports.push({
        ...entry,
        kind: from ? 'reexport' : 'local-export',
        source: from,
      });
      continue;
    }
    if (tokens[cursor]?.value === '*') {
      cursor += 1;
      let namespace = null;
      if (tokens[cursor]?.value === 'as') { namespace = tokens[cursor + 1]?.value; cursor += 2; }
      if (tokens[cursor]?.value !== 'from' || tokens[cursor + 1]?.type !== 'string') {
        module.failures.push({ guard: 2, file: basename(file), reason: 'export-star-parse' });
      } else if (namespace) {
        module.exports.push({ exported: namespace, local: '*', kind: 'namespace-reexport', source: tokens[cursor + 1].value });
      } else {
        module.stars.push(tokens[cursor + 1].value);
      }
      continue;
    }
    module.failures.push({ guard: 2, file: basename(file), reason: `unsupported-export:${tokens[cursor]?.value}` });
  }
  return module;
}

export function extractExportSurface({ files } = {}) {
  if (!Array.isArray(files)) throw new Error('FILES_REQUIRED');
  const failures = [];
  const modules = new Map();
  for (const input of files.map((file) => resolve(file)).sort(byteSort)) {
    if (extname(input) !== '.mjs') {
      failures.push({ guard: 1, file: basename(input), reason: 'non-mjs-script' });
      continue;
    }
    try {
      const parsed = parseModule(input);
      modules.set(input, parsed);
      failures.push(...parsed.failures);
    } catch (error) {
      failures.push({ guard: 2, file: basename(input), reason: String(error?.message || error) });
    }
  }

  const expanded = new Map();
  const expand = (module, stack = new Set()) => {
    if (expanded.has(module.file)) return expanded.get(module.file);
    if (stack.has(module.file)) throw new Error(`EXPORT_STAR_CYCLE:${module.idFile}`);
    const nextStack = new Set(stack).add(module.file);
    const rows = [...module.exports];
    for (const specifier of module.stars) {
      const target = sourceTarget(module.file, specifier, modules);
      if (!target) {
        failures.push({ guard: 3, file: module.idFile, reason: `unresolved-export-star:${specifier}` });
        continue;
      }
      for (const entry of expand(target, nextStack)) {
        if (entry.exported === 'default') continue;
        rows.push({ exported: entry.exported, local: entry.exported, kind: 'star-reexport', source: specifier });
      }
    }
    const unique = new Map();
    for (const row of rows) unique.set(row.exported, row);
    const result = [...unique.values()];
    expanded.set(module.file, result);
    return result;
  };

  const canonicalMemo = new Map();
  const canonical = (module, entry, stack = new Set()) => {
    const key = `${module.file}\0${entry.exported}`;
    if (canonicalMemo.has(key)) return canonicalMemo.get(key);
    const own = `${module.idFile}#${entry.exported}`;
    if (stack.has(key)) return own;
    const next = new Set(stack).add(key);
    let result = own;
    if (['reexport', 'star-reexport'].includes(entry.kind)) {
      const target = sourceTarget(module.file, entry.source, modules);
      if (target) {
        const targetEntry = expand(target).find((item) => item.exported === entry.local);
        if (targetEntry) result = canonical(target, targetEntry, next);
      }
    } else if (entry.kind === 'local-export' && entry.exported !== entry.local) {
      const direct = expand(module).find((item) => item.exported === entry.local && item !== entry);
      if (direct) result = canonical(module, direct, next);
      else {
        const imported = module.imports.get(entry.local);
        const target = imported && sourceTarget(module.file, imported.source, modules);
        const targetEntry = target && expand(target).find((item) => item.exported === imported.imported);
        if (targetEntry) result = canonical(target, targetEntry, next);
      }
    } else if (entry.kind === 'local-export') {
      const imported = module.imports.get(entry.local);
      const target = imported && sourceTarget(module.file, imported.source, modules);
      const targetEntry = target && expand(target).find((item) => item.exported === imported.imported);
      if (targetEntry) result = canonical(target, targetEntry, next);
    }
    canonicalMemo.set(key, result);
    return result;
  };

  const rawIds = [];
  const canonicalIds = [];
  for (const module of [...modules.values()].sort((a, b) => byteSort(a.file, b.file))) {
    for (const entry of expand(module)) {
      rawIds.push(`${module.idFile}#${entry.exported}`);
      canonicalIds.push(canonical(module, entry));
    }
  }
  return {
    raw_ids: [...new Set(rawIds)].sort(byteSort),
    canonical_ids: [...new Set(canonicalIds)].sort(byteSort),
    failures: failures.sort((a, b) => byteSort(JSON.stringify(a), JSON.stringify(b))),
    modules,
  };
}

const COMPLETE_ID = /`([A-Za-z0-9_-]+\.mjs#[A-Za-z_$][A-Za-z0-9_$]*)`/g;

function idsIn(text) {
  return [...new Set([...text.matchAll(COMPLETE_ID)].map((match) => match[1]))].sort(byteSort);
}

function span(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`CLASSIFICATION_MARKER_MISSING:${start}`);
  return text.slice(from, to);
}

function exactObject(value, keys, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort(byteSort)) !== JSON.stringify([...keys].sort(byteSort))) {
    throw new Error(`CLASSIFICATION_${label}_SHAPE`);
  }
}

export function parseLiveClassification({ seed, overlay } = {}) {
  if (typeof seed !== 'string' || typeof overlay !== 'string') throw new Error('CLASSIFICATION_TEXT_REQUIRED');
  const begin = '<!-- F26-LIVE-JSON-BEGIN -->';
  const end = '<!-- F26-LIVE-JSON-END -->';
  const startAt = overlay.indexOf(begin);
  const endAt = overlay.indexOf(end, startAt + begin.length);
  if (startAt < 0 || endAt < 0) throw new Error('CLASSIFICATION_OVERLAY_MARKER_MISSING');
  let config;
  try { config = JSON.parse(overlay.slice(startAt + begin.length, endAt).trim()); }
  catch (error) { throw new Error('CLASSIFICATION_OVERLAY_JSON_INVALID', { cause: error }); }
  exactObject(config, ['schema_version', 'seed_sha256', 'design_sha256', 'expected_counts', 'base_x_reasons', 'add'], 'OVERLAY');
  if (config.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(config.seed_sha256)
    || !/^[a-f0-9]{64}$/.test(config.design_sha256) || !Array.isArray(config.add)) {
    throw new Error('CLASSIFICATION_OVERLAY_VALUE_INVALID');
  }

  const sections = {
    L: span(seed, '**7.7-1', '**7.7-2'),
    B: span(seed, '**7.7-2', '**7.7-3'),
    X: span(seed, '**7.7-3', '**7.7-4'),
    E2: span(seed, '- **E2 ', '- **E3 '),
    E3: span(seed, '- **E3 ', '- **E4 '),
    E4: span(seed, '- **E4 ', '- **E5 '),
    E5: span(seed, '- **E5 ', '- **E7 '),
    E7: span(seed, '- **E7 ', '- **E8 '),
    E8: span(seed, '- **E8 ', '### 7.8'),
  };
  const fixedReasons = {
    L: 'leasecheck-dominated',
    B: 'explicit-activation-pending-block',
    E2: 'no-run-state-write',
    E3: 'infrastructure-primitive',
    E4: 'non-run-state-durable-write',
    E5: 'legacy-hook-adapter',
    E7: 'expanded-read-pure-non-run-state',
    E8: 'non-callable-value',
  };
  const rows = new Map();
  const insert = (id, classification, reason) => {
    if (rows.has(id)) throw new Error(`CLASSIFICATION_DUPLICATE:${id}`);
    rows.set(id, { classification, reason });
  };
  for (const [classification, text] of Object.entries(sections)) {
    if (classification === 'X') continue;
    for (const id of idsIn(text)) insert(id, classification, fixedReasons[classification]);
  }
  const xIds = new Set(idsIn(sections.X));
  const xAssigned = new Set();
  for (const [reason, identifiers] of Object.entries(config.base_x_reasons || {})) {
    if (!Array.isArray(identifiers)) throw new Error(`CLASSIFICATION_X_REASON_SHAPE:${reason}`);
    for (const id of identifiers) {
      if (!xIds.has(id) || xAssigned.has(id)) throw new Error(`CLASSIFICATION_X_REASON_MISMATCH:${id}`);
      xAssigned.add(id);
      insert(id, 'X', reason);
    }
  }
  if (xAssigned.size !== xIds.size) {
    throw new Error(`CLASSIFICATION_X_REASON_MISSING:${[...xIds].filter((id) => !xAssigned.has(id)).join(',')}`);
  }
  for (const item of config.add) {
    exactObject(item, ['id', 'classification', 'reason'], 'ADD');
    if (!/^[A-Za-z0-9_-]+\.mjs#[A-Za-z_$][A-Za-z0-9_$]*$/.test(item.id)) {
      throw new Error(`CLASSIFICATION_ADD_ID_INVALID:${item.id}`);
    }
    insert(item.id, item.classification, item.reason);
  }
  const ordered = new Map([...rows.entries()].sort(([left], [right]) => byteSort(left, right)));
  const measuredCounts = {};
  for (const { classification } of ordered.values()) {
    measuredCounts[classification] = (measuredCounts[classification] || 0) + 1;
  }
  const countEntries = Object.keys(config.expected_counts).map((key) => [key, measuredCounts[key] || 0]);
  const counts = Object.fromEntries(countEntries);
  if (JSON.stringify([...Object.entries(measuredCounts)].sort(([a], [b]) => byteSort(a, b)))
    !== JSON.stringify([...Object.entries(config.expected_counts)].sort(([a], [b]) => byteSort(a, b)))) {
    throw new Error(`CLASSIFICATION_COUNT_MISMATCH:${JSON.stringify(measuredCounts)}`);
  }
  return { rows: ordered, counts, config };
}

const WRITE_PRIMITIVES = new Set([
  'state.mjs#writeState',
  'integrity.mjs#appendEvent',
  'integrity.mjs#appendAnchored',
]);
const WRITE_GATEWAYS = new Set([
  'integrity.mjs#appendAnchored',
  'state.mjs#withReconciledMutationLock',
]);
const E_WRITE_GUARD = new Set(['E2', 'E3', 'E4', 'E5', 'E7', 'E8']);
const E3_IMPLEMENTATION_REFERENCES = new Map([
  ['integrity.mjs#appendAnchored', new Set(['state.mjs#writeState'])],
]);
const REASONS = Object.freeze({
  L: new Set(['leasecheck-dominated']),
  B: new Set(['explicit-activation-pending-block']),
  X: new Set(['structural-no-target', 'safety-downgrade', 'boot-observation', 'pause-direction',
    'human-only-recovery', 'damage-repair', 'acquire-chain', 'transitive', 'enforcement-origin',
    'treated-in-D2']),
  E2: new Set(['no-run-state-write']),
  E3: new Set(['infrastructure-primitive']),
  E4: new Set(['non-run-state-durable-write']),
  E5: new Set(['legacy-hook-adapter']),
  E7: new Set(['expanded-read-pure-non-run-state']),
  E8: new Set(['non-callable-value']),
});

function relativeSourcePath(file) {
  const normalized = file.replaceAll('\\', '/');
  const marker = '/scripts/';
  const at = normalized.lastIndexOf(marker);
  return at < 0 ? basename(file) : `scripts/${normalized.slice(at + marker.length)}`;
}

function braceDepths(tokens) {
  const depths = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    depths[index] = depth;
    if (tokens[index].value === '{') depth += 1;
    if (tokens[index].value === '}') depth -= 1;
  }
  return depths;
}

function findFunctionBody(tokens, functionIndex) {
  let cursor = functionIndex + 1;
  if (tokens[cursor]?.value === '*') cursor += 1;
  if (IDENTIFIER.test(tokens[cursor]?.value || '')) cursor += 1;
  while (cursor < tokens.length && tokens[cursor].value !== '(') cursor += 1;
  const closeParameters = matching(tokens, cursor, '(', ')');
  if (closeParameters < 0 || tokens[closeParameters + 1]?.value !== '{') return null;
  const closeBody = matching(tokens, closeParameters + 1, '{', '}');
  if (closeBody < 0) return null;
  return { parametersOpen: cursor, parametersClose: closeParameters, open: closeParameters + 1, close: closeBody };
}

function parameterAliases(module, records, body) {
  const aliases = new Map();
  const tokens = module.tokens;
  for (let index = body.parametersOpen + 1; index < body.parametersClose - 1; index += 1) {
    if (!IDENTIFIER.test(tokens[index]?.value || '') || tokens[index + 1]?.value !== '='
      || !IDENTIFIER.test(tokens[index + 2]?.value || '')) continue;
    const fallback = tokens[index + 2].value;
    aliases.set(tokens[index].value, originForImport(module, fallback) || records.get(fallback)?.id
      || `${module.idFile}#${fallback}`);
  }
  return aliases;
}

function functionRecords(module) {
  const records = new Map();
  const { tokens } = module;
  const depths = braceDepths(tokens);
  for (let index = 0; index < tokens.length; index += 1) {
    if (depths[index] !== 0) continue;
    let functionIndex = index;
    if (tokens[index].value === 'async' && tokens[index + 1]?.value === 'function') functionIndex += 1;
    if (tokens[functionIndex]?.value === 'function') {
      const nameIndex = tokens[functionIndex + 1]?.value === '*' ? functionIndex + 2 : functionIndex + 1;
      const name = tokens[nameIndex]?.value;
      const body = findFunctionBody(tokens, functionIndex);
      if (IDENTIFIER.test(name || '') && body) {
        const record = {
          id: `${module.idFile}#${name}`,
          module,
          name,
          start: body.open + 1,
          end: body.close,
          line: tokens[functionIndex].line,
          aliases: new Map(),
        };
        records.set(name, record);
        record.aliases = parameterAliases(module, records, body);
        index = body.close;
      }
      continue;
    }
    if (!['const', 'let', 'var'].includes(tokens[index].value)) continue;
    const name = tokens[index + 1]?.value;
    if (!IDENTIFIER.test(name || '')) continue;
    let cursor = index + 2;
    while (cursor < tokens.length && depths[cursor] === 0 && !['=>', ';'].includes(tokens[cursor].value)) cursor += 1;
    if (tokens[cursor]?.value !== '=>') continue;
    let start = cursor + 1;
    let end = start + 1;
    if (tokens[start]?.value === '{') {
      end = matching(tokens, start, '{', '}');
      start += 1;
    } else {
      while (end < tokens.length && depths[end] === 0 && ![';', ','].includes(tokens[end].value)) end += 1;
    }
    if (end < 0) continue;
    records.set(name, {
      id: `${module.idFile}#${name}`,
      module,
      name,
      start,
      end,
      line: tokens[index].line,
      aliases: new Map(),
    });
    index = end;
  }
  return records;
}

function originForImport(module, binding) {
  const imported = module.imports.get(binding);
  if (!imported) return null;
  return `${basename(imported.source)}#${imported.imported}`;
}

function callAt(record, index, recordsByFile) {
  const tokens = record.module.tokens;
  const token = tokens[index];
  if (!token || token.type !== 'identifier') return null;
  if (tokens[index + 1]?.value === '(') {
    const close = matching(tokens, index + 1, '(', ')');
    if (close < 0) return { failure: 'call-parenthesis-parse' };
    const imported = originForImport(record.module, token.value);
    const local = recordsByFile.get(record.module.file)?.get(token.value)?.id;
    return { target: imported || local || record.aliases.get(token.value) || null,
      open: index + 1, close, callee: token.value };
  }
  if (tokens[index + 1]?.value === '.' && IDENTIFIER.test(tokens[index + 2]?.value || '')
    && tokens[index + 3]?.value === '(') {
    const imported = record.module.imports.get(token.value);
    const close = matching(tokens, index + 3, '(', ')');
    if (close < 0) return { failure: 'call-parenthesis-parse' };
    return {
      target: imported?.imported === '*' ? `${basename(imported.source)}#${tokens[index + 2].value}` : null,
      open: index + 3,
      close,
      callee: `${token.value}.${tokens[index + 2].value}`,
    };
  }
  return null;
}

function splitArguments(tokens, open, close) {
  const args = [];
  let start = open + 1;
  let depth = 0;
  for (let index = open + 1; index < close; index += 1) {
    if (['(', '[', '{'].includes(tokens[index].value)) depth += 1;
    if ([')', ']', '}'].includes(tokens[index].value)) depth -= 1;
    if (tokens[index].value === ',' && depth === 0) {
      args.push([start, index]);
      start = index + 1;
    }
  }
  args.push([start, close]);
  return args;
}

function rangeHasIdentifier(tokens, range, identifier) {
  if (!range) return false;
  return tokens.slice(range[0], range[1]).some((token) => token.type === 'identifier' && token.value === identifier);
}

function rangeIsConditional(tokens, range, identifier) {
  if (!range) return false;
  const target = tokens.findIndex((token, index) => index >= range[0] && index < range[1]
    && token.type === 'identifier' && token.value === identifier);
  if (target < 0) return false;
  for (let index = range[0]; index < target; index += 1) {
    if (tokens[index].value === '?') {
      let nesting = 0;
      for (let cursor = index + 1; cursor < range[1]; cursor += 1) {
        if (['(', '[', '{'].includes(tokens[cursor].value)) nesting += 1;
        if ([')', ']', '}'].includes(tokens[cursor].value)) nesting -= 1;
        if (nesting === 0 && tokens[cursor].value === ':') {
          if (index < target && target < cursor) return true;
          break;
        }
      }
    }
    if (tokens[index].value === '&&') {
      let cursor = index + 1;
      let nesting = 0;
      while (cursor < range[1]) {
        if (['(', '[', '{'].includes(tokens[cursor].value)) nesting += 1;
        if ([')', ']', '}'].includes(tokens[cursor].value)) nesting -= 1;
        if (nesting === 0 && [';', ','].includes(tokens[cursor].value)) break;
        cursor += 1;
      }
      if (target < cursor) return true;
    }
    if (tokens[index].value !== 'if' || tokens[index + 1]?.value !== '(') continue;
    const closeCondition = matching(tokens, index + 1, '(', ')');
    if (closeCondition < 0 || closeCondition >= target) continue;
    if (tokens[closeCondition + 1]?.value === '{') {
      const closeBody = matching(tokens, closeCondition + 1, '{', '}');
      if (closeBody >= target) return true;
    } else {
      let statementEnd = closeCondition + 1;
      while (statementEnd < range[1] && tokens[statementEnd].value !== ';') statementEnd += 1;
      if (statementEnd >= target) return true;
    }
  }
  return false;
}

function rangeLeaseStatus(record, range, recordsByFile, seen = new Set()) {
  if (!range) return null;
  const tokens = record.module.tokens;
  if (rangeHasIdentifier(tokens, range, 'leaseCheck')) {
    return rangeIsConditional(tokens, range, 'leaseCheck') ? 'conditional-dominates' : 'dominates';
  }
  for (let index = range[0]; index < range[1]; index += 1) {
    const call = callAt(record, index, recordsByFile);
    if (!call?.target || seen.has(call.target)) continue;
    const local = recordsByFile.get(record.module.file);
    const helper = local && [...local.values()].find((candidate) => candidate.id === call.target);
    if (!helper) continue;
    const helperRange = [helper.start, helper.end];
    const status = rangeLeaseStatus(helper, helperRange, recordsByFile, new Set(seen).add(call.target));
    if (status) return status;
  }
  return null;
}

function directFacts(record, recordsByFile) {
  const tokens = record.module.tokens;
  const calls = [];
  const failures = [];
  const primitiveReferences = new Set();
  for (let index = record.start; index < record.end; index += 1) {
    if (tokens[index].value === ']' && tokens[index + 1]?.value === '(') {
      failures.push({ guard: 2, file: record.module.idFile, reason: 'unsupported-dynamic-call' });
    }
    if (tokens[index].type !== 'identifier') continue;
    const origin = originForImport(record.module, tokens[index].value);
    if (origin && WRITE_PRIMITIVES.has(origin)) primitiveReferences.add(origin);
    const call = callAt(record, index, recordsByFile);
    if (!call) continue;
    if (call.failure) failures.push({ guard: 2, file: record.module.idFile, reason: call.failure });
    else if (call.target) {
      const fact = { ...call, line: tokens[index].line, coordinate: `${relativeSourcePath(record.module.file)}:${tokens[index].line}` };
      const args = splitArguments(tokens, call.open, call.close);
      if (call.target === 'integrity.mjs#appendAnchored') {
        fact.precheck = rangeLeaseStatus(record, args[4], recordsByFile) || 'does-not-dominate';
      }
      if (call.target === 'state.mjs#withReconciledMutationLock') {
        const callback = args[2];
        const hasWrite = ['writeState', 'appendEvent', 'appendAnchored']
          .some((identifier) => rangeHasIdentifier(tokens, callback, identifier));
        if (hasWrite) {
          fact.precheck = rangeHasIdentifier(tokens, callback, 'leaseCheck')
            ? (rangeIsConditional(tokens, callback, 'leaseCheck') ? 'conditional-dominates' : 'dominates')
            : 'does-not-dominate';
        }
      }
      calls.push(fact);
    }
  }
  return { calls, failures, primitiveReferences };
}

function exportedRecord(modules, recordsByFile, id) {
  const separator = id.lastIndexOf('#');
  const fileName = id.slice(0, separator);
  const exported = id.slice(separator + 1);
  const module = [...modules.values()].find((candidate) => candidate.idFile === fileName);
  if (!module) return null;
  const entry = module.exports.find((candidate) => candidate.exported === exported);
  const local = entry?.local || exported;
  return recordsByFile.get(module.file)?.get(local) || null;
}

function exportedInitializerPrimitiveReferences(modules, id) {
  const separator = id.lastIndexOf('#');
  const fileName = id.slice(0, separator);
  const exported = id.slice(separator + 1);
  const module = [...modules.values()].find((candidate) => candidate.idFile === fileName);
  if (!module) return new Set();
  const entry = module.exports.find((candidate) => candidate.exported === exported);
  const local = entry?.local || exported;
  const tokens = module.tokens;
  const depths = braceDepths(tokens);
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (depths[index] !== 0 || !['const', 'let', 'var'].includes(tokens[index].value)) continue;
    let cursor = index + 1;
    while (cursor < tokens.length && depths[cursor] === 0) {
      const name = tokens[cursor]?.value;
      if (name === local && tokens[cursor + 1]?.value === '=') {
        const references = new Set();
        let nesting = 0;
        for (let valueIndex = cursor + 2; valueIndex < tokens.length; valueIndex += 1) {
          const value = tokens[valueIndex].value;
          if (['(', '[', '{'].includes(value)) nesting += 1;
          if ([')', ']', '}'].includes(value)) nesting -= 1;
          if (nesting === 0 && [',', ';'].includes(value)) break;
          const origin = tokens[valueIndex].type === 'identifier'
            ? originForImport(module, tokens[valueIndex].value) : null;
          if (origin && WRITE_PRIMITIVES.has(origin)) references.add(origin);
        }
        return references;
      }
      if (tokens[cursor].value === ';') break;
      cursor += 1;
    }
  }
  return new Set();
}

function mergeDominance(left, right) {
  if (left === 'not-applicable') return right;
  if (right === 'not-applicable') return left;
  const rank = { 'does-not-dominate': 1, 'conditional-dominates': 2, dominates: 3 };
  return rank[right] < rank[left] ? right : left;
}

function analyzeRecord(record, factsById, recordsById, stack = new Set()) {
  if (!record) return { reaches: false, dominance: 'not-applicable', path: [], coordinates: [] };
  if (stack.has(record.id)) return { reaches: false, dominance: 'not-applicable', path: [], coordinates: [] };
  const facts = factsById.get(record.id);
  let reaches = false;
  let dominance = 'not-applicable';
  let path = [];
  let coordinates = [];
  for (const call of facts.calls) {
    if (WRITE_PRIMITIVES.has(call.target)) {
      reaches = true;
      let nextDominance = 'does-not-dominate';
      if (call.target === 'integrity.mjs#appendAnchored') nextDominance = call.precheck;
      else {
        const enclosing = facts.calls.find((candidate) => candidate.target === 'state.mjs#withReconciledMutationLock'
          && candidate.open < call.open && call.close < candidate.close && candidate.precheck);
        if (enclosing) nextDominance = enclosing.precheck;
      }
      dominance = mergeDominance(dominance, nextDominance);
      if (path.length === 0) {
        path = [record.id, call.target];
        coordinates = [call.coordinate];
      }
      continue;
    }
    const child = recordsById.get(call.target);
    if (!child) continue;
    const nested = analyzeRecord(child, factsById, recordsById, new Set(stack).add(record.id));
    if (!nested.reaches) continue;
    reaches = true;
    dominance = mergeDominance(dominance, nested.dominance);
    if (path.length === 0) {
      path = [record.id, ...nested.path];
      coordinates = [call.coordinate, ...nested.coordinates];
    }
  }
  return { reaches, dominance: reaches ? dominance : 'not-applicable', path, coordinates };
}

function recordOrCalleeContains(record, factsById, recordsById, needle, stack = new Set()) {
  if (!record || stack.has(record.id)) return false;
  const own = record.module.tokens.slice(record.start, record.end).some((token) => token.raw.includes(needle));
  if (own) return true;
  const next = new Set(stack).add(record.id);
  return factsById.get(record.id).calls.some((call) =>
    recordOrCalleeContains(recordsById.get(call.target), factsById, recordsById, needle, next));
}

function sortedEvidence(items) {
  return items.sort((left, right) => byteSort(JSON.stringify(left), JSON.stringify(right)));
}

export function analyzeClassification({ files, live, requireExactSurface = true } = {}) {
  if (!(live?.rows instanceof Map)) throw new Error('LIVE_CLASSIFICATION_REQUIRED');
  const surface = extractExportSurface({ files });
  const modules = surface.modules;
  const recordsByFile = new Map([...modules.values()].map((module) => [module.file, functionRecords(module)]));
  const recordsById = new Map();
  for (const records of recordsByFile.values()) for (const record of records.values()) recordsById.set(record.id, record);
  const factsById = new Map();
  const analysisFailures = [];
  for (const record of recordsById.values()) {
    const facts = directFacts(record, recordsByFile);
    factsById.set(record.id, facts);
    analysisFailures.push(...facts.failures);
  }
  const failures = [...surface.failures, ...analysisFailures]
    .sort((left, right) => byteSort(JSON.stringify(left), JSON.stringify(right)));
  const violations = [];
  if (requireExactSurface) {
    const liveIds = [...live.rows.keys()].sort(byteSort);
    if (JSON.stringify(surface.canonical_ids) !== JSON.stringify(liveIds)) {
      violations.push({ code: 'CLASSIFICATION_SURFACE_MISMATCH' });
    }
  }
  const rows = [];
  for (const [id, declared] of live.rows) {
    if (!REASONS[declared.classification]?.has(declared.reason)) {
      violations.push({ code: `CLASSIFICATION_REASON_MISMATCH:${id}` });
    }
    const record = exportedRecord(modules, recordsByFile, id);
    const calculated = analyzeRecord(record, factsById, recordsById);
    const primitiveReferences = new Set([
      ...(record ? factsById.get(record.id)?.primitiveReferences || [] : []),
      ...exportedInitializerPrimitiveReferences(modules, id),
    ]);
    let dominance = calculated.dominance;
    if (declared.classification === 'B') dominance = 'not-applicable';
    const evidence = calculated.reaches
      ? sortedEvidence([{
        kind: calculated.path.length > 2 ? 'transitive' : 'direct',
        path: calculated.path,
        coordinates: calculated.coordinates,
      }, ...(dominance === 'not-applicable' ? [] : [{
        kind: dominance === 'dominates' ? 'dominance'
          : dominance === 'conditional-dominates' ? 'conditional-dominance' : 'non-dominance',
        path: calculated.path,
        coordinates: calculated.coordinates,
      }])])
      : [{ kind: 'no-path', path: [id], coordinates: record ? [`${relativeSourcePath(record.module.file)}:${record.line}`] : [] }];
    const row = {
      id,
      classification: declared.classification,
      write_reachability: calculated.reaches ? 'reaches' : 'does-not-reach',
      leasecheck_dominance: dominance,
      reason: declared.reason,
      evidence,
    };
    rows.push(row);
    if (declared.classification === 'L' && (!calculated.reaches
      || !['dominates', 'conditional-dominates'].includes(dominance))) {
      violations.push({ code: 'L_WRITE_NOT_DOMINATED', id });
    }
    const unexpectedPrimitiveReferences = [...primitiveReferences].filter((primitive) =>
      !E3_IMPLEMENTATION_REFERENCES.get(id)?.has(primitive));
    if (E_WRITE_GUARD.has(declared.classification) && unexpectedPrimitiveReferences.length > 0) {
      violations.push({ code: 'E_DIRECT_OR_REFERENCE_WRITE', id });
    }
    if ((declared.classification === 'X' && declared.reason === 'structural-no-target'
      || declared.classification === 'E2' && declared.reason === 'no-run-state-write'
      || declared.classification === 'E8' && declared.reason === 'non-callable-value') && calculated.reaches) {
      violations.push({ code: 'CLASSIFICATION_RECALCULATION_MISMATCH', id });
    }
    if ((declared.classification === 'X' && declared.reason === 'transitive'
      || declared.classification === 'B') && !calculated.reaches) {
      violations.push({ code: 'CLASSIFICATION_RECALCULATION_MISMATCH', id });
    }
    if (declared.classification === 'B' && record
      && !recordOrCalleeContains(record, factsById, recordsById, 'ACTIVATION_PENDING')) {
      violations.push({ code: 'B_BLOCK_MISSING', id });
    }
  }
  rows.sort((left, right) => byteSort(left.id, right.id));
  violations.sort((left, right) => byteSort(`${left.code}:${left.id || ''}`, `${right.code}:${right.id || ''}`));
  return { rows, failures, violations, candidate_ids: surface.canonical_ids };
}
