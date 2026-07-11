import { realpathSync, existsSync, lstatSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

// containedRealFile(baseAbs, rel): returns the canonical absolute path of `rel` (a base-relative path) IFF it is
// an existing regular file whose realpath (symlinks dereferenced) stays under the realpath of baseAbs; otherwise
// null. `resolve`+`startsWith` alone is LEXICAL — it does not dereference symlinks, so a base-relative symlink
// could point outside the project and still pass. realpathSync closes that escape (design-R3 #6).
export function containedRealFile(baseAbs, rel) {
  if (typeof rel !== 'string' || !rel.length) return null;
  if (isAbsolute(rel) || rel.split(/[/\\]/).includes('..')) return null;   // lexical pre-reject (before any FS access)
  const full = resolve(baseAbs, rel);
  if (!existsSync(full)) return null;
  let rBase, rFull;
  try { rBase = realpathSync(baseAbs); rFull = realpathSync(full); } catch { return null; }
  if (rFull !== rBase && !rFull.startsWith(rBase + sep)) return null;      // containment AFTER symlink deref
  try { if (!statSync(rFull).isFile()) return null; } catch { return null; }   // dirs / special files rejected
  return rFull;
}

export function pathWithin(baseReal, candidateReal) {
  return candidateReal === baseReal || candidateReal.startsWith(baseReal + sep);
}

// Durable artifact paths use '/' on every host. Validation is deliberately independent of the
// current host's path grammar so POSIX, drive, and UNC absolute forms cannot cross runtimes.
export function normalizePortableRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return null;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  return normalized;
}

export function containedRealFileWithin(projectRoot, rel, withinAbs) {
  const normalized = normalizePortableRelativePath(rel);
  if (!normalized) return null;
  const file = containedRealFile(projectRoot, normalized);
  if (!file) return null;
  try {
    const project = realpathSync(projectRoot);
    const within = realpathSync(withinAbs);
    if (!statSync(within).isDirectory() || !pathWithin(project, within) || !pathWithin(within, file)) return null;
  } catch { return null; }
  return file;
}

export function canonicalNonSymlinkDirectory(path) {
  try {
    const lexical = lstatSync(path);
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) return null;
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) return null;
    return canonical;
  } catch { return null; }
}
