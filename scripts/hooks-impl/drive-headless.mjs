import { findRoot } from '../lib/state.mjs';
import { driveHeadless } from '../lib/headless-host.mjs';
import { detectMain } from '../lib/detect-main.mjs';

export { driveHeadless } from '../lib/headless-host.mjs';

export function main() {
  const result = driveHeadless({ root: findRoot(process.cwd()) });
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
