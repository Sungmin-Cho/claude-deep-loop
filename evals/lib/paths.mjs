import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const CLI_PATH = resolve(REPO_ROOT, 'scripts/deep-loop.mjs');
