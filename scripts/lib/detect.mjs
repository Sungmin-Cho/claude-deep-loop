import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Known plugin-cache roots across runtimes. `installed` is the UNION over these — a best-effort
// "this sibling is installed somewhere" discovery signal. Routing keys on `present` (installed OR
// initialized marker), which is robust to install-detection imperfection: a missed install falls back
// to the project marker, and the 2-plane boundary means the executor verifies callability at dispatch.
const CACHE_ROOTS = [join('.claude', 'plugins', 'cache'), join('.codex', 'plugins', 'cache')];
const PLUGINS = ['deep-work', 'deep-review', 'deep-docs', 'deep-evolve', 'deep-dashboard', 'deep-memory', 'deep-wiki', 'codex'];

const has = (p) => { try { return existsSync(p); } catch { return false; } };
const ls = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };

// Collect installed plugin NAMES from a cache root by reading plugin manifests at bounded depth (1..3).
// Reading the manifest `name` handles BOTH cache layouts uniformly (IMPL-ADV5):
//   - versioned marketplace:  <root>/<market>/<plugin>/<version>/.{claude,codex}-plugin/plugin.json
//   - direct (git/local):     <root>/<entry>/.{claude,codex}-plugin/plugin.json  (plugin name only in the manifest)
function installedNamesIn(cacheRoot) {
  const names = new Set();
  const collect = (dir) => {
    for (const md of ['.claude-plugin', '.codex-plugin']) {
      try {
        const j = JSON.parse(readFileSync(join(dir, md, 'plugin.json'), 'utf8'));
        if (j && typeof j.name === 'string' && j.name) names.add(j.name);
      } catch { /* no/invalid manifest here */ }
    }
  };
  for (const a of ls(cacheRoot)) {                 // depth 1 (direct entry OR marketplace)
    collect(join(cacheRoot, a));
    for (const b of ls(join(cacheRoot, a))) {       // depth 2 (plugin)
      collect(join(cacheRoot, a, b));
      for (const c of ls(join(cacheRoot, a, b))) {  // depth 3 (version)
        collect(join(cacheRoot, a, b, c));
      }
    }
  }
  return names;
}

function initializedOf(root, home) {
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

export function detectPlugins(root, home = homedir()) {
  // Union of installed names across all known cache roots (runtime-agnostic, layout-robust best-effort).
  const installedNames = new Set();
  for (const rel of CACHE_ROOTS) for (const n of installedNamesIn(join(home, rel))) installedNames.add(n);
  const init = initializedOf(root, home);
  const out = {};
  for (const name of PLUGINS) {
    const installed = installedNames.has(name);
    const initialized = !!init[name];
    out[name] = { installed, initialized, present: installed || initialized };
  }
  return out;
}

// pluginPresent = "installed somewhere OR initialized in this project" — the routing/recommendation signal.
// Routing keys on this (the user's chosen Problem C contract); the 2-plane boundary means the Execution-plane
// LLM verifies callability when it actually dispatches the recommended reviewer/protocol.
// Tolerant: accepts the object shape (.present) and the legacy flat boolean.
export function pluginPresent(detected, name) {
  const v = (detected || {})[name];
  return v === true || (v != null && typeof v === 'object' && v.present === true);
}
