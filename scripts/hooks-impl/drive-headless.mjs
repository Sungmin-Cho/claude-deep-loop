import { findRoot } from '../lib/state.mjs';
import { driveHeadless } from '../lib/headless-host.mjs';
import { detectMain } from '../lib/detect-main.mjs';

export { driveHeadless } from '../lib/headless-host.mjs';

export function parseHeadlessArgs(argv = []) {
  if (!Array.isArray(argv)) return { ok: false, reason: 'argv-invalid' };
  let projectRoot = null;
  let runId = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--project-root' && flag !== '--run-id') {
      return { ok: false, reason: 'argv-invalid' };
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      return { ok: false, reason: 'argv-invalid' };
    }
    if (flag === '--project-root') {
      if (projectRoot !== null) return { ok: false, reason: 'argv-invalid' };
      projectRoot = value;
    } else {
      if (runId !== null) return { ok: false, reason: 'argv-invalid' };
      runId = value;
    }
    index += 1;
  }
  if (argv.length > 0 && (projectRoot === null || runId === null)) {
    return { ok: false, reason: 'argv-invalid' };
  }
  return { ok: true, projectRoot, runId, hasArgv: argv.length > 0 };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseHeadlessArgs(argv);
  if (!parsed.ok) {
    const result = { ok: false, action: 'routing-failed', reason: parsed.reason };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
    return result;
  }
  const root = parsed.projectRoot === null ? findRoot(process.cwd()) : parsed.projectRoot;
  const result = driveHeadless({
    root,
    ...(parsed.runId === null ? {} : { runId: parsed.runId }),
    // An argv-bearing invocation is authoritative and must not fall back to
    // ambient environment identity.  With no argv the resolver validates the
    // complete kernel-produced headless identity itself.
    envIdentity: parsed.hasArgv ? null : env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
  return result;
}

const { isMain, diagnostic } = detectMain(import.meta.url, process.argv[1]);
if (diagnostic) {
  process.stderr.write(`${diagnostic}\n`);
} else if (isMain) {
  main();
}
