import { findRoot, runDir } from '../lib/state.mjs';
import { driveHeadless } from '../lib/headless-host.mjs';
import { detectMain } from '../lib/detect-main.mjs';

export { driveHeadless } from '../lib/headless-host.mjs';

export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv); const result = parsed === null ? { ok: false, action: 'fail-closed', reason: 'arguments-invalid' } : driveHeadless({ root: findRoot(process.cwd()), ...parsed });
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

function parseArgs(argv) {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== '--run-id' || !argv[1] || argv[1].startsWith('--')) return null;
  try { runDir('.', argv[1]); } catch { return null; }
  return { runId: argv[1] };
}
