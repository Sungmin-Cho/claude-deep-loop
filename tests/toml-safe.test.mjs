import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tomlBasicString, tomlQuotedKeySegment } from '../scripts/lib/toml-safe.mjs';

test('tomlBasicString encodes path-like values as one TOML basic string', () => {
  const fixtures = [
    ['C:\\Users\\Alice\\repo', '"C:\\\\Users\\\\Alice\\\\repo"'],
    ['\\\\server\\share\\repo', '"\\\\\\\\server\\\\share\\\\repo"'],
    ['/work tree/repo', '"/work tree/repo"'],
    ['/work/repo.v1', '"/work/repo.v1"'],
    ["/work/O'Brien/repo", '"/work/O\'Brien/repo"'],
    ['C:\\say"hi\\repo', '"C:\\\\say\\"hi\\\\repo"'],
  ];

  for (const [value, expected] of fixtures) {
    assert.equal(tomlBasicString(value), expected, value);
  }
});

test('tomlQuotedKeySegment keeps dotted-key/config injection inside one quoted segment', () => {
  const hostile = 'C:\\repo".trust_level="trusted';
  assert.equal(
    tomlQuotedKeySegment(hostile),
    '"C:\\\\repo\\".trust_level=\\"trusted"',
  );
  assert.equal(tomlQuotedKeySegment('space.dot and apostrophe\'s'), '"space.dot and apostrophe\'s"');
});

test('TOML encoders reject NUL, every C0 control, and DEL', () => {
  for (let code = 0; code <= 0x1f; code += 1) {
    const value = `left${String.fromCharCode(code)}right`;
    assert.throws(() => tomlBasicString(value), /INVALID_TOML_STRING/, `C0 U+${code.toString(16).padStart(4, '0')}`);
    assert.throws(() => tomlQuotedKeySegment(value), /INVALID_TOML_STRING/, `quoted C0 U+${code.toString(16).padStart(4, '0')}`);
  }
  assert.throws(() => tomlBasicString(`left${String.fromCharCode(0x7f)}right`), /INVALID_TOML_STRING/);
});

test('TOML encoders reject unpaired surrogates but retain valid pairs', () => {
  for (const value of ['\ud800', '\udbff', '\udc00', '\udfff', 'left\ud800right', 'left\udcffright']) {
    assert.throws(() => tomlQuotedKeySegment(value), /INVALID_TOML_STRING/, JSON.stringify(value));
  }
  assert.equal(tomlQuotedKeySegment('repo-\ud83d\ude80'), '"repo-\ud83d\ude80"');
});

test('TOML encoders reject non-string input instead of coercing it', () => {
  for (const value of [null, undefined, 1, {}, []]) {
    assert.throws(() => tomlBasicString(value), /INVALID_TOML_STRING/);
  }
});
