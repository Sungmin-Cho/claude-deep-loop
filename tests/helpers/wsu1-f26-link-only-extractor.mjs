#!/usr/bin/env node
import vm from 'node:vm';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baselineNode20RegularFiles } from './baseline-node20-walk.mjs';

function fail(message, details = {}) {
  process.stderr.write(`${JSON.stringify({ error: message, ...details })}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--scripts-root' || argv[1].length === 0) {
    throw new Error('usage: wsu1-f26-link-only-extractor.mjs --scripts-root <dir>');
  }
  return realpathSync(resolve(argv[1]));
}

function byteSort(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function main() {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('VM_MODULES_UNAVAILABLE: run with --experimental-vm-modules');
  }
  const scriptsRoot = parseArgs(process.argv.slice(2));
  const repositoryRoot = realpathSync(dirname(scriptsRoot));
  const allFiles = baselineNode20RegularFiles(scriptsRoot);
  const invalidExtensions = allFiles.filter((file) => !file.endsWith('.mjs'));
  if (invalidExtensions.length > 0) {
    throw new Error(`NON_MJS_SCRIPTS: ${invalidExtensions.join(',')}`);
  }

  const context = vm.createContext({});
  const modules = new Map();
  const failures = [];
  const sourceModule = (file) => {
    const identifier = pathToFileURL(file).href;
    if (modules.has(identifier)) return modules.get(identifier);
    try {
      const module = new vm.SourceTextModule(readFileSync(file, 'utf8'), {
        context,
        identifier,
      });
      modules.set(identifier, module);
      return module;
    } catch (error) {
      failures.push({ file, phase: 'parse', message: String(error?.message || error) });
      return null;
    }
  };
  for (const file of allFiles) {
    sourceModule(file);
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
    if (specifier.startsWith('node:')) {
      const namespace = await import(specifier);
      const synthetic = new vm.SyntheticModule(
        Object.getOwnPropertyNames(namespace), () => {}, { context, identifier: specifier },
      );
      modules.set(specifier, synthetic);
      return synthetic;
    }
    let resolved;
    try {
      resolved = new URL(specifier, referencingModule.identifier).href;
    } catch (error) {
      throw new Error(`UNRESOLVED_IMPORT: ${specifier} from ${referencingModule.identifier}`, { cause: error });
    }
    if (!resolved.startsWith('file:')) {
      throw new Error(`UNRESOLVED_IMPORT: ${specifier} from ${referencingModule.identifier}`);
    }
    const lexical = fileURLToPath(resolved);
    const rel = relative(repositoryRoot, lexical);
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(repositoryRoot, rel) !== resolve(lexical)) {
      throw new Error(`IMPORT_OUTSIDE_REPOSITORY: ${specifier} from ${referencingModule.identifier}`);
    }
    if (extname(lexical) !== '.mjs') {
      throw new Error(`NON_MJS_IMPORT: ${specifier} from ${referencingModule.identifier}`);
    }
    let canonical;
    let stat;
    try {
      stat = lstatSync(lexical);
      canonical = realpathSync(lexical);
    } catch (error) {
      throw new Error(`UNRESOLVED_IMPORT: ${specifier} from ${referencingModule.identifier}`, { cause: error });
    }
    const canonicalRel = relative(repositoryRoot, canonical);
    if (stat.isSymbolicLink() || !stat.isFile()
      || canonicalRel === '..' || canonicalRel.startsWith(`..${sep}`)) {
      throw new Error(`UNSAFE_REPOSITORY_IMPORT: ${specifier} from ${referencingModule.identifier}`);
    }
    return sourceModule(canonical);
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
