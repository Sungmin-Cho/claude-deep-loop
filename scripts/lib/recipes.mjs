import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pluginPresent } from './detect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const recipesDir = join(here, '../../recipes');

export function loadRecipes(dir = recipesDir) {
  // recipes/에는 recipe 아닌 데이터 파일(hillclimb-ledger.json)도 있다 — malformed/null JSON 하나가
  // recipe 라우팅 전체(모든 init의 recipe-match)를 깨뜨리지 않도록 파일 단위로 건너뛴다.
  return readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); }
      catch { process.stderr.write(`[deep-loop:warn] recipe ${f}: invalid JSON — skipped (validate가 fail-closed로 잡는다)\n`); return null; }
    })
    .filter(r => r && Array.isArray(r.triggers));
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
