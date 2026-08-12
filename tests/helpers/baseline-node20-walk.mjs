import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const byteSort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

export function baselineNode20RegularFiles(root) {
  const directories = [root];
  const files = [];
  while (directories.length > 0) {
    const parent = directories.pop();
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const child = join(parent, entry.name);
      if (entry.isDirectory()) {
        directories.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`BASELINE_NODE20_NON_REGULAR_FILE: ${child}`);
      }
      files.push(child);
    }
  }
  return files.sort(byteSort);
}
