import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pluginPresent } from './detect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const recipesDir = join(here, '../../recipes');

export function loadRecipes() {
  return readdirSync(recipesDir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(recipesDir, f), 'utf8')));
}

export function matchRecipe(goal, detected = {}, recipes = loadRecipes()) {
  const g = String(goal).toLowerCase();
  let chosen = recipes.find(r => r.triggers.some(t => g.includes(t.toLowerCase())));
  if (!chosen) chosen = recipes.find(r => r.id === 'triage-and-discovery');
  let protocol;
  if (g.includes('superpowers')) protocol = 'superpowers';
  else if (chosen.protocol_hint === 'deep-work' && pluginPresent(detected, 'deep-work')) protocol = 'deep-work';
  else protocol = 'standalone';
  return { recipe: chosen.id, protocol, reason: `matched ${chosen.id}; protocol=${protocol}` };
}
