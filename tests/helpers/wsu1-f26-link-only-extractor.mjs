#!/usr/bin/env node
import vm from 'node:vm';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function fail(message, details = {}) {
  process.stderr.write(`${JSON.stringify({ error: message, ...details })}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--scripts-root' || argv[1].length === 0) {
    throw new Error('usage: wsu1-f26-link-only-extractor.mjs --scripts-root <dir>');
  }
  return resolve(argv[1]);
}

function byteSort(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function regularFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort(byteSort);
}

async function main() {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('VM_MODULES_UNAVAILABLE: run with --experimental-vm-modules');
  }
  const scriptsRoot = parseArgs(process.argv.slice(2));
  const allFiles = regularFiles(scriptsRoot);
  const invalidExtensions = allFiles.filter((file) => !file.endsWith('.mjs'));
  if (invalidExtensions.length > 0) {
    throw new Error(`NON_MJS_SCRIPTS: ${invalidExtensions.join(',')}`);
  }

  const context = vm.createContext({});
  const modules = new Map();
  const failures = [];
  for (const file of allFiles) {
    const identifier = pathToFileURL(file).href;
    try {
      modules.set(identifier, new vm.SourceTextModule(readFileSync(file, 'utf8'), {
        context,
        identifier,
      }));
    } catch (error) {
      failures.push({ file, phase: 'parse', message: String(error?.message || error) });
    }
  }
  if (failures.length > 0) {
    throw new Error(`MODULE_PARSE_FAILED: ${JSON.stringify(failures)}`);
  }

  const builtinSpecifiers = new Set();
  for (const file of allFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/["'](node:[^"']+)["']/g)) {
      builtinSpecifiers.add(match[1]);
    }
  }
  for (const specifier of builtinSpecifiers) {
    const namespace = await import(specifier);
    modules.set(specifier, new vm.SyntheticModule(
      Object.getOwnPropertyNames(namespace),
      () => {},
      { context, identifier: specifier },
    ));
  }

  const linker = async (specifier, referencingModule) => {
    const direct = modules.get(specifier);
    if (direct) return direct;
    let resolved;
    try {
      resolved = new URL(specifier, referencingModule.identifier).href;
    } catch (error) {
      throw new Error(`UNRESOLVED_IMPORT: ${specifier} from ${referencingModule.identifier}`, { cause: error });
    }
    const target = modules.get(resolved);
    if (!target) throw new Error(`UNRESOLVED_IMPORT: ${specifier} from ${referencingModule.identifier}`);
    return target;
  };

  for (const file of allFiles) {
    const module = modules.get(pathToFileURL(file).href);
    try {
      if (module.status === 'unlinked') await module.link(linker);
    } catch (error) {
      failures.push({ file, phase: 'link', message: String(error?.message || error) });
    }
  }
  if (failures.length > 0) {
    throw new Error(`MODULE_LINK_FAILED: ${JSON.stringify(failures)}`);
  }

  const files = allFiles.map((file) => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`NON_REGULAR_SCRIPT: ${file}`);
    }
    const module = modules.get(pathToFileURL(file).href);
    const exportNames = Object.getOwnPropertyNames(module.namespace).sort(byteSort);
    return {
      path: file.slice(scriptsRoot.length + 1).split('\\').join('/'),
      module: basename(file),
      export_names: exportNames,
    };
  });
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    scripts_root: scriptsRoot,
    file_count: files.length,
    raw_export_name_count: files.reduce((sum, file) => sum + file.export_names.length, 0),
    files,
    failures,
  })}\n`);
}

main().catch((error) => fail(String(error?.message || error)));
