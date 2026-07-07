import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pluginPresent } from './detect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const recipesDir = join(here, '../../recipes');

// recipe shape: 문자열 id + 전원 문자열인 triggers 배열. 원소 타입까지 강제해야 matchRecipe의
// `t.toLowerCase()`가 non-string 트리거(예: null)에서 TypeError로 라우팅 전체를 다운시키지 않는다
// (Phase6 ITEM-2 — validate와 loadRecipes 양쪽 게이트가 이 조건을 공유한다).
function isValidRecipeShape(r) {
  return Boolean(r) && typeof r.id === 'string'
    && Array.isArray(r.triggers) && r.triggers.every(t => typeof t === 'string');
}

// validate(preflight/머지 게이트)가 fail-closed로 손상 recipe를 파일명과 함께 잡는 정적 검사 —
// 런타임 loadRecipes(fail-soft skip)와 반드시 **같은 디렉터리**(플러그인 번들 recipesDir)를 봐야 한다.
// project-root 기준(join(root,'recipes'))으로 검사하면 --project-root가 타 프로젝트를 가리킬 때
// (1) 번들 recipe가 미검증되고 (2) 무관한 사용자 recipes/*.json에 false-failure가 난다.
export function validateRecipesDir(dir = recipesDir) {
  const errors = [];
  if (!existsSync(dir)) return { ok: true, errors };
  for (const rf of readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'hillclimb-ledger.json')) {
    try {
      const r = JSON.parse(readFileSync(join(dir, rf), 'utf8'));
      if (!r || typeof r.id !== 'string') errors.push(`recipe ${rf}: id must be a string`);
      else if (!Array.isArray(r.triggers)) errors.push(`recipe ${rf}: triggers must be an array`);
      else if (!r.triggers.every(t => typeof t === 'string')) errors.push(`recipe ${rf}: triggers must be an array of strings`);
    } catch (e) { errors.push(`recipe ${rf}: ${e.message}`); }
  }
  return { ok: errors.length === 0, errors };
}

export function loadRecipes(dir = recipesDir) {
  // recipes/에는 recipe 아닌 데이터 파일(hillclimb-ledger.json)도 있다 — 이 예외는 파일명으로 조용히
  // 건너뛴다(경고 없음, validateRecipesDir과 동형 exclusion). 그 외 malformed/null JSON이나 shape
  // 위반(id 비문자열·triggers 비배열·triggers 원소 비문자열) recipe는 개별적으로 stderr 경고 후
  // skip한다 — 파일 하나의 손상이 recipe 라우팅 전체(모든 init의 recipe-match)를 깨뜨리지 않도록.
  return readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'hillclimb-ledger.json')
    .map(f => {
      let parsed;
      try { parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
      catch { process.stderr.write(`[deep-loop:warn] recipe ${f}: invalid JSON — skipped (validate가 fail-closed로 잡는다)\n`); return null; }
      if (!isValidRecipeShape(parsed)) {
        process.stderr.write(`[deep-loop:warn] recipe ${f}: invalid shape (id must be a string, triggers must be a string[]) — skipped (validate가 fail-closed로 잡는다)\n`);
        return null;
      }
      return parsed;
    })
    .filter(Boolean);
}

export function matchRecipe(goal, detected = {}, recipes = loadRecipes()) {
  const g = String(goal).toLowerCase();
  // Phase6 warning-2: longest-matching-trigger wins (not first-match by readdirSync/file order) — a broad
  // trigger (e.g. "improve") must not shadow a more specific one (e.g. "hill-climb") in a combined goal
  // string; strict '>' keeps file order as the tie-break (ends the r1/r2/r5 broad-trigger-shadowing class).
  let chosen = null;
  let bestLen = -1;
  for (const r of recipes) {
    let localBest = -1;
    for (const t of r.triggers) { const tl = t.toLowerCase(); if (g.includes(tl) && tl.length > localBest) localBest = tl.length; }
    if (localBest > bestLen) { bestLen = localBest; chosen = r; }
  }
  if (!chosen) chosen = recipes.find(r => r.id === 'triage-and-discovery');
  let protocol;
  if (g.includes('superpowers')) protocol = 'superpowers';
  else if (chosen.protocol_hint === 'deep-work' && pluginPresent(detected, 'deep-work')) protocol = 'deep-work';
  else protocol = 'standalone';
  return { recipe: chosen.id, protocol, reason: `matched ${chosen.id}; protocol=${protocol}` };
}
