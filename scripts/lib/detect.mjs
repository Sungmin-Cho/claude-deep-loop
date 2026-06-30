import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const RUNTIME_CACHE = { claude: join('.claude', 'plugins', 'cache'), codex: join('.codex', 'plugins', 'cache') };
const PLUGINS = ['deep-work', 'deep-review', 'deep-docs', 'deep-evolve', 'deep-dashboard', 'deep-memory', 'deep-wiki', 'codex'];

const has = (p) => { try { return existsSync(p); } catch { return false; } };
const ls = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };

// True if <cacheRoot>/<marketplace>/<plugin>/<version>/.{claude,codex}-plugin/plugin.json exists for any marketplace/version.
// A versioned manifest (not a bare/stale dir) is the minimum evidence of an actually-installed plugin.
function installedIn(cacheRoot, plugin) {
  for (const market of ls(cacheRoot)) {
    const pdir = join(cacheRoot, market, plugin);
    if (!has(pdir)) continue;
    for (const version of ls(pdir)) {
      if (has(join(pdir, version, '.claude-plugin', 'plugin.json')) ||
          has(join(pdir, version, '.codex-plugin', 'plugin.json'))) return true;
    }
  }
  return false;
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

// pluginPath defaults to the RESOLVED path of THIS module (unspoofable) — NOT a parent-controlled env var
// (CLAUDE_PLUGIN_ROOT is spoofable). Injectable for tests.
export function detectPlugins(root, home = homedir(), pluginPath = fileURLToPath(import.meta.url)) {
  // Current runtime = whichever cache the running deep-loop module lives in (Claude default for dev/standalone).
  const isCodex = typeof pluginPath === 'string' && pluginPath.includes(RUNTIME_CACHE.codex);
  const curRoot = join(home, isCodex ? RUNTIME_CACHE.codex : RUNTIME_CACHE.claude);
  const otherRoot = join(home, isCodex ? RUNTIME_CACHE.claude : RUNTIME_CACHE.codex);
  const init = initializedOf(root, home);
  const out = {};
  for (const name of PLUGINS) {
    const installed = installedIn(curRoot, name);
    const installed_other = installedIn(otherRoot, name);
    const initialized = !!init[name];
    out[name] = { installed, installed_other, initialized, present: installed || initialized };
  }
  return out;
}

// Tolerant: accepts the object shape (.present) and the legacy flat boolean.
export function pluginPresent(detected, name) {
  const v = (detected || {})[name];
  return v === true || (v != null && typeof v === 'object' && v.present === true);
}
