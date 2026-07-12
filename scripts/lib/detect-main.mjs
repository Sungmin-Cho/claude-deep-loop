import { realpathSync as defaultRealpathSync } from 'node:fs';
import { resolve as defaultResolve } from 'node:path';
import { fileURLToPath as defaultFileURLToPath, pathToFileURL as defaultPathToFileURL } from 'node:url';

const result = (isMain, diagnostic = null) => ({ isMain, diagnostic });

export function detectMain(moduleUrl, argvPath, deps = {}) {
  if (typeof argvPath !== 'string' || argvPath.length === 0) return result(false);

  let parsedModuleUrl;
  try {
    parsedModuleUrl = new URL(moduleUrl);
  } catch {
    return result(false, 'DEEP_LOOP_MAIN_FILE_URL_FAILED');
  }
  if (parsedModuleUrl.protocol !== 'file:') return result(false, 'DEEP_LOOP_MAIN_NON_FILE_URL');

  const fileURLToPath = deps.fileURLToPath || defaultFileURLToPath;
  const resolve = deps.resolve || defaultResolve;
  const realpathSync = deps.realpathSync || defaultRealpathSync;
  const pathToFileURL = deps.pathToFileURL || defaultPathToFileURL;

  let modulePath;
  try {
    modulePath = fileURLToPath(parsedModuleUrl);
  } catch {
    return result(false, 'DEEP_LOOP_MAIN_FILE_URL_FAILED');
  }

  let resolvedModulePath;
  let resolvedArgvPath;
  try {
    resolvedModulePath = resolve(modulePath);
    resolvedArgvPath = resolve(argvPath);
  } catch {
    return result(false, 'DEEP_LOOP_MAIN_RESOLVE_FAILED');
  }

  const realpath = realpathSync.native || realpathSync;
  let canonicalModulePath;
  let canonicalArgvPath;
  try {
    canonicalModulePath = realpath(resolvedModulePath);
    canonicalArgvPath = realpath(resolvedArgvPath);
  } catch {
    return result(false, 'DEEP_LOOP_MAIN_REALPATH_FAILED');
  }

  try {
    const moduleHref = pathToFileURL(canonicalModulePath).href;
    const argvHref = pathToFileURL(canonicalArgvPath).href;
    return result(moduleHref === argvHref);
  } catch {
    return result(false, 'DEEP_LOOP_MAIN_PATH_URL_FAILED');
  }
}
