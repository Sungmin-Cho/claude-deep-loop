function invalidTomlString(reason) {
  return Object.assign(new Error(`INVALID_TOML_STRING: ${reason}`), { code: 'INVALID_TOML_STRING' });
}

function validateTomlString(value) {
  if (typeof value !== 'string') throw invalidTomlString('expected string');
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) throw invalidTomlString(`disallowed control U+${code.toString(16).padStart(4, '0')}`);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalidTomlString('unpaired high surrogate');
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidTomlString('unpaired low surrogate');
    }
  }
  return value;
}

export function tomlBasicString(value) {
  const safe = validateTomlString(value);
  return `"${safe.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function tomlQuotedKeySegment(value) {
  return tomlBasicString(value);
}
