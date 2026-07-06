import { realpathSync, existsSync, statSync } from 'node:fs';
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
