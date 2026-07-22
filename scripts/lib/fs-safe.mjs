import { realpathSync, existsSync, lstatSync, statSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { relativePathWithin } from './path-portable.mjs';

// containedRealFile(baseAbs, rel): returns the canonical absolute path of `rel` (a base-relative path) IFF it is
// an existing regular file whose realpath (symlinks dereferenced) stays under the realpath of baseAbs; otherwise
// null. `resolve`+`startsWith` alone is LEXICAL — it does not dereference symlinks, so a base-relative symlink
// could point outside the project and still pass. realpathSync closes that escape (design-R3 #6).
export function containedRealFile(baseAbs, rel) {
  const normalized = normalizePortableRelativePath(rel);
  if (!normalized) return null;   // lexical pre-reject (before any FS access)
  const full = resolve(baseAbs, normalized);
  if (!existsSync(full)) return null;
  let rBase, rFull;
  try { rBase = realpathSync(baseAbs); rFull = realpathSync(full); } catch { return null; }
  if (!pathWithin(rBase, rFull)) return null;      // containment AFTER symlink deref
  try { if (!statSync(rFull).isFile()) return null; } catch { return null; }   // dirs / special files rejected
  return rFull;
}

export function pathWithin(baseReal, candidateReal, { pathApi = path } = {}) {
  return relativePathWithin(baseReal, candidateReal, { pathApi });
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

function canonicalIdentityInteger(value) {
  try {
    const integer = typeof value === 'bigint' ? value : BigInt(value);
    if (integer < 0n) return null;
    return integer.toString(10);
  } catch {
    return null;
  }
}

export function captureStableFileIdentity(path, { lstatFn = lstatSync } = {}) {
  const stat = lstatFn(path, { bigint: true });
  const dev = canonicalIdentityInteger(stat?.dev);
  const ino = canonicalIdentityInteger(stat?.ino);
  const birthtimeNs = canonicalIdentityInteger(stat?.birthtimeNs);
  if (dev === null || ino === null || birthtimeNs === null) {
    throw new Error('FILE_IDENTITY_UNAVAILABLE');
  }
  return Object.freeze({ dev, ino, birthtime_ns: birthtimeNs });
}

function canonicalIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, 'dev') || !Object.hasOwn(value, 'ino')
    || !Object.hasOwn(value, 'birthtime_ns')) return null;
  const values = [value.dev, value.ino, value.birthtime_ns];
  if (values.some(item => typeof item !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(item))) return null;
  return { dev: BigInt(value.dev), ino: BigInt(value.ino), birthtimeNs: BigInt(value.birthtime_ns) };
}

export function matchingStableFileIdentity(left, right) {
  const a = canonicalIdentity(left);
  const b = canonicalIdentity(right);
  if (!a || !b || a.ino === 0n || b.ino === 0n || a.ino !== b.ino) return false;
  if (a.dev !== 0n && b.dev !== 0n) return a.dev === b.dev;
  return a.birthtimeNs !== 0n && b.birthtimeNs !== 0n && a.birthtimeNs === b.birthtimeNs;
}
