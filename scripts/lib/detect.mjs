import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function detectPlugins(root, home = homedir()) {
  const has = (p) => { try { return existsSync(p); } catch { return false; } };
  return {
    'deep-work': has(join(root, '.claude', 'deep-work-profile.yaml')) || has(join(root, '.deep-work')),
    'deep-review': has(join(root, '.deep-review', 'config.yaml')) || has(join(root, '.deep-review')),
    'deep-docs': has(join(root, '.deep-docs')),
    'deep-evolve': has(join(root, '.deep-evolve', 'session.yaml')) || has(join(root, '.deep-evolve')),
    'deep-dashboard': has(join(root, '.deep-dashboard')),
    'deep-memory': has(join(root, '.deep-memory', 'project-profile.json')) || has(join(home, '.deep-memory')),
    'deep-wiki': has(join(home, '.claude', 'deep-wiki-config.yaml')),
    'codex': has(join(home, '.codex')),
  };
}
