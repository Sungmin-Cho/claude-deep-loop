import { findRoot } from '../lib/state.mjs';
import { driveHeadless } from '../lib/headless-host.mjs';

export { driveHeadless } from '../lib/headless-host.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = driveHeadless({ root: findRoot(process.cwd()) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
