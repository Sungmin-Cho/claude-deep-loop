export function isLexicalRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')
    || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('//')) return false;
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

export function assertLexicalRelativePath(value, code) {
  if (!isLexicalRelativePath(value)) throw new Error(code);
  return value;
}
