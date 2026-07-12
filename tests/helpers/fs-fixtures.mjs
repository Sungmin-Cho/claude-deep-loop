import { mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fixtureDir(prefix = 'dl-fixture-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function canonicalRealpath(path) {
  return (realpathSync.native || realpathSync)(path);
}

export function createDirectoryJunction(target, link, {
  platform = process.platform,
  symlink = symlinkSync,
} = {}) {
  symlink(target, link, platform === 'win32' ? 'junction' : 'dir');
}

export function createFileSymlink(target, link, {
  symlink = symlinkSync,
} = {}) {
  symlink(target, link, 'file');
}

export function createFileSymlinkOrSkip(testContext, target, link, {
  platform = process.platform,
  symlink = symlinkSync,
} = {}) {
  try {
    createFileSymlink(target, link, { symlink });
    return true;
  } catch (error) {
    if (platform === 'win32' && error?.code === 'EPERM') {
      testContext.skip('Windows file-symlink privilege is unavailable (EPERM)');
      return false;
    }
    throw error;
  }
}
